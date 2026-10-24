-- =============================================================
-- 20261024_payment_actual_amounts.sql
--
-- THE BUG THIS FIXES
--   `payment_grants.amount_paise` existed but nothing ever wrote to it:
--   `fulfil_payment_order()` inserted only payment_id / order_id / user_id /
--   plan_key / product_key / expires_at / coupon_code / discount_percent.
--   The admin panel therefore fell back to the *catalog* price of the plan,
--   so a learner who paid ₹119 for Pro Monthly (DIWALI01, 20% off) or
--   ₹799 for Pro Yearly still showed up as ₹149 / ₹999 in the admin panel,
--   in revenue totals and in the CSV export.
--
-- WHAT THIS MIGRATION DOES
--   1. Backfills `amount_paise`, `coupon_code` and `discount_percent` on
--      existing grants from the Razorpay order they were fulfilled from.
--   2. Adds a BEFORE INSERT/UPDATE trigger so every future grant records the
--      real charged amount (and coupon) even if the user app keeps inserting
--      grants without those columns.
--   3. Fixes `fulfil_payment_order()` so a fresh purchase writes
--      `amount_paise = p_amount` (the amount verified against Razorpay) and
--      repairs an older grant that was stored without an amount.
--   4. Adds `admin_record_grant_amount()` so a legacy grant that predates
--      payment_orders (and therefore has no recorded amount anywhere) can be
--      corrected by hand from the Razorpay dashboard — every correction is
--      written to `admin_audit_log`.
--
-- Idempotent: safe to run more than once.
-- =============================================================

-- ---------------------------------------------------------------
-- 0. Make sure the ledger has the columns this migration relies on
--    (a fresh install that only ran supabase-admin-setup.sql may not)
-- ---------------------------------------------------------------
alter table public.payment_grants add column if not exists amount_paise bigint;
alter table public.payment_grants add column if not exists product_key text;
alter table public.payment_grants add column if not exists coupon_code text;
alter table public.payment_grants add column if not exists discount_percent integer;

-- ---------------------------------------------------------------
-- 1. Backfill from the order that the grant was fulfilled from
-- ---------------------------------------------------------------
update public.payment_grants g
   set amount_paise = o.amount
  from public.payment_orders o
 where o.order_id = g.order_id
   and g.amount_paise is null
   and o.amount is not null;

update public.payment_grants g
   set coupon_code = o.coupon_code,
       discount_percent = coalesce(nullif(o.discount_percent, 0), 0)
  from public.payment_orders o
 where o.order_id = g.order_id
   and o.coupon_code is not null
   and coalesce(btrim(g.coupon_code), '') = '';

-- Older rows written before discount_percent was added.
update public.payment_grants
   set discount_percent = 0
 where discount_percent is null;

-- ---------------------------------------------------------------
-- 2. Trigger: never store a grant with a missing paid amount again
-- ---------------------------------------------------------------
create or replace function public.payment_grants_capture_actuals()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
declare
  o public.payment_orders%rowtype;
begin
  if new.order_id is not null then
    select * into o from public.payment_orders where order_id = new.order_id;

    if o.order_id is not null then
      -- The real amount Razorpay charged for this order (coupon already applied).
      if new.amount_paise is null then
        new.amount_paise := o.amount;
      end if;

      if coalesce(btrim(new.coupon_code), '') = '' then
        new.coupon_code := o.coupon_code;
      end if;

      if coalesce(new.discount_percent, 0) = 0 then
        new.discount_percent := coalesce(o.discount_percent, 0);
      end if;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_payment_grants_capture_actuals on public.payment_grants;
create trigger trg_payment_grants_capture_actuals
  before insert or update on public.payment_grants
  for each row execute function public.payment_grants_capture_actuals();

-- ---------------------------------------------------------------
-- 3. Fulfilment writes the verified paid amount into the ledger
-- ---------------------------------------------------------------
create or replace function public.fulfil_payment_order(
  p_user_id uuid,
  p_order_id text,
  p_payment_id text,
  p_amount integer,
  p_currency text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  o public.payment_orders%rowtype;
  g public.payment_grants%rowtype;
  current_expiry timestamptz;
  expiry timestamptz;
  unlimited boolean;
  v_redeemed_id uuid;
begin
  if p_payment_id is null or p_payment_id !~ '^pay_[A-Za-z0-9]+$' then
    raise exception 'Invalid payment id' using errcode = '22023';
  end if;

  select * into g from public.payment_grants where payment_id = p_payment_id;
  if g.payment_id is not null then
    if g.user_id is distinct from p_user_id or g.order_id is distinct from p_order_id then
      raise exception 'Receipt belongs to another account or order' using errcode = '42501';
    end if;

    -- Repair a grant that was written before the actual amount was recorded.
    if g.amount_paise is null then
      update public.payment_grants
         set amount_paise = p_amount
       where payment_id = p_payment_id
         and amount_paise is null;
      g.amount_paise := p_amount;
    end if;

    return jsonb_build_object(
      'success', true,
      'plan', g.plan_key,
      'product', g.product_key,
      'expiresAt', g.expires_at,
      'amountPaise', g.amount_paise,
      'alreadyGranted', true,
      'couponCode', g.coupon_code,
      'discountPercent', coalesce(g.discount_percent, 0)
    );
  end if;

  select * into o from public.payment_orders where order_id = p_order_id for update;
  if o.order_id is null then
    raise exception 'Order requires verified legacy ownership binding' using errcode = 'P0002';
  end if;
  if o.user_id is distinct from p_user_id then
    raise exception 'Order belongs to another account' using errcode = '42501';
  end if;
  if o.amount is distinct from p_amount or o.currency is distinct from p_currency then
    raise exception 'Paid amount or currency does not match order' using errcode = '22023';
  end if;

  select * into g from public.payment_grants where payment_id = p_payment_id;
  if g.payment_id is null then
    select * into g from public.payment_grants where order_id = p_order_id order by created_at limit 1;
    if g.payment_id is not null then
      raise exception 'Order already fulfilled by a different payment. Do not pay again.' using errcode = 'P0003';
    end if;
  end if;
  if g.payment_id is not null then
    if g.user_id is distinct from p_user_id or g.order_id is distinct from p_order_id then
      raise exception 'Receipt belongs to another account or order' using errcode = '42501';
    end if;
    return jsonb_build_object(
      'success', true,
      'plan', g.plan_key,
      'product', g.product_key,
      'expiresAt', g.expires_at,
      'amountPaise', g.amount_paise,
      'alreadyGranted', true,
      'couponCode', g.coupon_code,
      'discountPercent', coalesce(g.discount_percent, 0)
    );
  end if;

  insert into public.profiles(id) values (p_user_id) on conflict (id) do nothing;
  select premium_expires_at, coalesce(is_premium, false) and premium_expires_at is null
    into current_expiry, unlimited
    from public.profiles where id = p_user_id for update;

  if o.product_key = 'pro' then
    expiry := greatest(coalesce(current_expiry, now()), now()) + make_interval(days => o.duration_days);
    update public.profiles
    set is_premium = true,
        premium_expires_at = case when unlimited then null else expiry end,
        is_first_purchase = false
    where id = p_user_id;
  else
    select expires_at into current_expiry
    from public.product_entitlements
    where user_id = p_user_id and product_key = o.product_key;
    expiry := greatest(coalesce(current_expiry, now()), now()) + make_interval(days => o.duration_days);
    update public.profiles set is_first_purchase = false where id = p_user_id;
  end if;

  insert into public.product_entitlements(user_id, product_key, expires_at)
  values (p_user_id, o.product_key, expiry)
  on conflict (user_id, product_key) do update
    set expires_at = excluded.expires_at, updated_at = now();

  -- amount_paise is the amount Razorpay actually captured (p_amount is checked
  -- against o.amount above), so discounts are part of the permanent ledger.
  insert into public.payment_grants(
    payment_id, order_id, user_id, plan_key, product_key, expires_at,
    amount_paise, coupon_code, discount_percent
  )
  values (
    p_payment_id, p_order_id, p_user_id, o.plan_key, o.product_key, expiry,
    p_amount, o.coupon_code, coalesce(o.discount_percent, 0)
  );

  if o.coupon_code is not null and exists (select 1 from public.coupons where code = o.coupon_code) then
    insert into public.coupon_redemptions(
      coupon_code, user_id, order_id, payment_id, plan_key, discount_percent, amount_paid
    )
    values (
      o.coupon_code, p_user_id, o.order_id, p_payment_id, o.plan_key,
      greatest(1, coalesce(o.discount_percent, 1)), p_amount
    )
    on conflict (order_id) do nothing
    returning id into v_redeemed_id;

    if v_redeemed_id is not null then
      update public.coupons
      set used_count = used_count + 1,
          updated_at = now()
      where code = o.coupon_code;
    end if;
  end if;

  return jsonb_build_object(
    'success', true,
    'plan', o.plan_key,
    'product', o.product_key,
    'expiresAt', expiry,
    'amountPaise', p_amount,
    'alreadyGranted', false,
    'couponCode', o.coupon_code,
    'discountPercent', coalesce(o.discount_percent, 0)
  );
end;
$$;

revoke all on function public.fulfil_payment_order(uuid, text, text, integer, text) from anon, authenticated;
grant execute on function public.fulfil_payment_order(uuid, text, text, integer, text) to service_role;

-- ---------------------------------------------------------------
-- 4. Let an admin correct a legacy grant's recorded amount
--    (rows that predate payment_orders have no amount anywhere)
-- ---------------------------------------------------------------
create or replace function public.admin_record_grant_amount(
  p_payment_id text,
  p_amount_paise bigint
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  g public.payment_grants%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  if p_payment_id is null or p_payment_id = '' then
    raise exception 'Payment id required' using errcode = '22023';
  end if;

  -- ₹1,00,000 in paise; protects against a mistyped decimal point.
  if p_amount_paise is null or p_amount_paise < 0 or p_amount_paise > 10000000 then
    raise exception 'Invalid amount' using errcode = '22023';
  end if;

  select * into g from public.payment_grants where payment_id = p_payment_id for update;
  if g.payment_id is null then
    raise exception 'Payment not found' using errcode = 'P0002';
  end if;

  update public.payment_grants
     set amount_paise = p_amount_paise
   where payment_id = p_payment_id;

  insert into public.admin_audit_log(
    admin_id, action, admin_role, resource, target_id,
    old_value, new_value, reason, metadata, entity_type, entity_id
  )
  values (
    auth.uid(), 'payment_grant.amount_recorded', 'admin', 'payment_grants', p_payment_id,
    jsonb_build_object('amount_paise', g.amount_paise),
    jsonb_build_object('amount_paise', p_amount_paise),
    'Actual Razorpay amount recorded from the admin panel',
    jsonb_build_object('order_id', g.order_id, 'plan_key', g.plan_key),
    'payment_grants', p_payment_id
  );

  return jsonb_build_object(
    'paymentId', p_payment_id,
    'amountPaise', p_amount_paise,
    'previousPaise', g.amount_paise
  );
end;
$$;

revoke all on function public.admin_record_grant_amount(text, bigint) from anon, public;
grant execute on function public.admin_record_grant_amount(text, bigint) to authenticated;

notify pgrst, 'reload schema';
