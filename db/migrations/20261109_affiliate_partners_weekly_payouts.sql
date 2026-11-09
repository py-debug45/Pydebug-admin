-- PyDebug Affiliate / Collaborator system with Sunday payout batches.
-- Apply only after the existing premium coupon + payment_grants tables exist.
-- Money is always stored in paise. This migration does NOT expose Razorpay secrets
-- or initiate a transfer: standard Razorpay checkout is not RazorpayX Payouts.

begin;

-- Existing PyDebug checkout owns discount validation. This migration only maps
-- a coupon to an approved collaborator and snapshots commission per paid grant.
do $$ begin
  if to_regclass('public.coupons') is null then
    raise exception 'public.coupons is missing. Install the PyDebug premium coupon migration first.';
  end if;
  if to_regclass('public.payment_grants') is null then
    raise exception 'public.payment_grants is missing. Install the PyDebug payment ledger first.';
  end if;
  if to_regclass('public.payment_orders') is null then
    raise exception 'public.payment_orders is missing. Install the PyDebug payment checkout migration first.';
  end if;
end $$;

alter table public.coupons
  add column if not exists affiliate_partner_id uuid,
  add column if not exists affiliate_commission_percent numeric(5,2);

create table if not exists public.affiliate_partners (
  user_id uuid primary key references auth.users(id) on delete cascade,
  public_name text not null check (char_length(public_name) between 2 and 80),
  social_url text,
  payout_upi text,
  status text not null default 'pending' check (status in ('pending','approved','rejected','suspended')),
  commission_percent numeric(5,2) not null default 20 check (commission_percent between 0 and 50),
  default_discount_percent integer not null default 10 check (default_discount_percent between 0 and 80),
  applied_at timestamptz not null default now(),
  terms_accepted_at timestamptz not null default now(),
  terms_version text not null default '2026-11-09-v1',
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null,
  review_note text,
  updated_at timestamptz not null default now()
);

alter table public.affiliate_partners
  add column if not exists terms_accepted_at timestamptz not null default now(),
  add column if not exists terms_version text not null default '2026-11-09-v1';

-- Snapshot attribution and commission terms when Razorpay order is created.
-- A later coupon reassignment/rate change must never move an in-flight order.
alter table public.payment_orders
  add column if not exists affiliate_partner_id uuid,
  add column if not exists affiliate_commission_percent numeric(5,2);

create table if not exists public.affiliate_payout_batches (
  id uuid primary key default gen_random_uuid(),
  period_start date not null,
  period_end date not null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  status text not null default 'open' check (status in ('open','complete')),
  check (period_end >= period_start)
);

create table if not exists public.affiliate_payouts (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.affiliate_payout_batches(id) on delete restrict,
  partner_user_id uuid not null references public.affiliate_partners(user_id) on delete restrict,
  amount_paise bigint not null check (amount_paise > 0),
  commissions_count integer not null default 0,
  status text not null default 'pending' check (status in ('pending','paid','failed')),
  payment_reference text,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(batch_id, partner_user_id)
);

create table if not exists public.affiliate_commissions (
  id uuid primary key default gen_random_uuid(),
  partner_user_id uuid not null references public.affiliate_partners(user_id) on delete restrict,
  coupon_code text not null,
  payment_id text not null unique,
  order_id text,
  plan_key text,
  sale_amount_paise bigint not null check (sale_amount_paise >= 0),
  commission_percent numeric(5,2) not null check (commission_percent between 0 and 50),
  commission_paise bigint not null check (commission_paise >= 0),
  status text not null default 'pending' check (status in ('pending','approved','paid','reversed')),
  eligible_at timestamptz not null,
  payout_id uuid references public.affiliate_payouts(id) on delete restrict,
  created_at timestamptz not null default now(),
  reversed_at timestamptz,
  reversal_reason text,
  adjustment_reason text
);

alter table public.affiliate_commissions add column if not exists adjustment_reason text;

create index if not exists affiliate_partners_status_idx on public.affiliate_partners(status, applied_at desc);
create index if not exists affiliate_commissions_partner_idx on public.affiliate_commissions(partner_user_id, created_at desc);
create index if not exists affiliate_commissions_due_idx on public.affiliate_commissions(status, eligible_at) where payout_id is null;
create index if not exists affiliate_payouts_partner_idx on public.affiliate_payouts(partner_user_id, created_at desc);

alter table public.affiliate_partners enable row level security;
alter table public.affiliate_commissions enable row level security;
alter table public.affiliate_payout_batches enable row level security;
alter table public.affiliate_payouts enable row level security;
-- All reads/writes go through narrow SECURITY DEFINER RPCs, never direct table access.
revoke all on public.affiliate_partners, public.affiliate_commissions,
  public.affiliate_payout_batches, public.affiliate_payouts from anon, authenticated;
revoke all on public.affiliate_partners, public.affiliate_commissions,
  public.affiliate_payout_batches, public.affiliate_payouts from public;

create or replace function public.affiliate_apply(
  p_public_name text,
  p_social_url text default null,
  p_payout_upi text default null,
  p_accept_terms boolean default false
) returns jsonb
language plpgsql security definer
set search_path = public, auth, pg_temp
as $$
declare v_uid uuid := auth.uid(); v_row public.affiliate_partners%rowtype;
begin
  if v_uid is null then raise exception 'Sign in required' using errcode='42501'; end if;
  if p_accept_terms is distinct from true then raise exception 'Accept the affiliate program terms before applying' using errcode='22023'; end if;
  if length(btrim(coalesce(p_public_name,''))) not between 2 and 80 then
    raise exception 'Name must be 2–80 characters' using errcode='22023';
  end if;
  if p_social_url is not null and (length(p_social_url)>300 or p_social_url !~* '^https://') then
    raise exception 'Social/profile link must start with https://' using errcode='22023';
  end if;
  if p_payout_upi is not null and (length(p_payout_upi)>100 or p_payout_upi !~ '^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$') then
    raise exception 'Enter a valid UPI ID' using errcode='22023';
  end if;
  insert into public.affiliate_partners(user_id,public_name,social_url,payout_upi,terms_accepted_at,terms_version)
  values(v_uid,btrim(p_public_name),nullif(btrim(p_social_url),''),nullif(btrim(p_payout_upi),''),now(),'2026-11-09-v1')
  on conflict(user_id) do update set
    public_name=excluded.public_name, social_url=excluded.social_url,
    payout_upi=excluded.payout_upi, terms_accepted_at=now(), terms_version='2026-11-09-v1', updated_at=now(),
    applied_at=case when affiliate_partners.status in ('rejected','suspended') then now() else affiliate_partners.applied_at end,
    status=case when affiliate_partners.status in ('rejected','suspended') then 'pending' else affiliate_partners.status end;
  select * into v_row from public.affiliate_partners where user_id=v_uid;
  return jsonb_build_object('status',v_row.status,'publicName',v_row.public_name,'commissionPercent',v_row.commission_percent);
end $$;

create or replace function public.affiliate_partner_dashboard()
returns jsonb language plpgsql stable security definer
set search_path = public, auth, pg_temp
as $$
declare v_uid uuid := auth.uid(); v_partner public.affiliate_partners%rowtype;
begin
  if v_uid is null then raise exception 'Sign in required' using errcode='42501'; end if;
  select * into v_partner from public.affiliate_partners where user_id=v_uid;
  if not found then return jsonb_build_object('applied',false); end if;
  return jsonb_build_object(
    'applied',true,'status',v_partner.status,'publicName',v_partner.public_name,
    'commissionPercent',v_partner.commission_percent,'defaultDiscountPercent',v_partner.default_discount_percent,
    'payoutUpi',v_partner.payout_upi,'socialUrl',v_partner.social_url,'reviewNote',v_partner.review_note,
    'pendingPaise',(select coalesce(sum(commission_paise),0) from public.affiliate_commissions where partner_user_id=v_uid and status='pending'),
    'approvedPaise',(select coalesce(sum(commission_paise),0) from public.affiliate_commissions where partner_user_id=v_uid and status='approved'),
    'paidPaise',(select coalesce(sum(commission_paise),0) from public.affiliate_commissions where partner_user_id=v_uid and status='paid'),
    'salesCount',(select count(*) from public.affiliate_commissions where partner_user_id=v_uid and status <> 'reversed'),
    'coupons',(select coalesce(jsonb_agg(jsonb_build_object('code',c.code,'discountPercent',c.discount_percent,'active',coalesce(c.is_active,true)) order by c.code),'[]'::jsonb)
      from public.coupons c where c.affiliate_partner_id=v_uid),
    'payouts',(select coalesce(jsonb_agg(jsonb_build_object('amountPaise',p.amount_paise,'status',p.status,'reference',p.payment_reference,'paidAt',p.paid_at,'createdAt',p.created_at) order by p.created_at desc),'[]'::jsonb)
      from (select * from public.affiliate_payouts where partner_user_id=v_uid order by created_at desc limit 20) p)
  );
end $$;

create or replace function public.affiliate_admin_list_partners()
returns table(user_id uuid,email text,public_name text,social_url text,payout_upi text,status text,
  commission_percent numeric,default_discount_percent integer,applied_at timestamptz,review_note text,
  sales_count bigint,pending_paise bigint,approved_paise bigint,paid_paise bigint)
language plpgsql stable security definer
set search_path = public, auth, pg_temp
as $$
begin
  if not public.has_perm('coupons.read') then raise exception 'Permission denied: coupons.read' using errcode='42501'; end if;
  return query select a.user_id,u.email::text,a.public_name,a.social_url,a.payout_upi,a.status,
    a.commission_percent,a.default_discount_percent,a.applied_at,a.review_note,
    (select count(*) from public.affiliate_commissions c where c.partner_user_id=a.user_id and c.status<>'reversed'),
    (select coalesce(sum(c.commission_paise),0) from public.affiliate_commissions c where c.partner_user_id=a.user_id and c.status='pending'),
    (select coalesce(sum(c.commission_paise),0) from public.affiliate_commissions c where c.partner_user_id=a.user_id and c.status='approved' and c.payout_id is null),
    (select coalesce(sum(c.commission_paise),0) from public.affiliate_commissions c where c.partner_user_id=a.user_id and c.status='paid')
  from public.affiliate_partners a left join auth.users u on u.id=a.user_id order by a.applied_at desc;
end $$;

create or replace function public.affiliate_admin_review_partner(
  p_user_id uuid,p_status text,p_commission_percent numeric default 20,
  p_discount_percent integer default 10,p_note text default null
) returns void language plpgsql security definer
set search_path = public, auth, pg_temp
as $$
begin
  if not public.has_perm('coupons.write') then raise exception 'Permission denied: coupons.write' using errcode='42501'; end if;
  if p_status not in ('approved','rejected','suspended','pending') then raise exception 'Invalid status' using errcode='22023'; end if;
  if p_commission_percent not between 0 and 50 or p_discount_percent not between 0 and 80 then raise exception 'Rate out of range' using errcode='22023'; end if;
  update public.affiliate_partners set status=p_status,commission_percent=p_commission_percent,
    default_discount_percent=p_discount_percent,reviewed_at=now(),reviewed_by=auth.uid(),
    review_note=nullif(left(coalesce(p_note,''),500),''),updated_at=now() where user_id=p_user_id;
  if not found then raise exception 'Collaborator not found' using errcode='P0002'; end if;
  if p_status in ('rejected','suspended') then
    update public.coupons set is_active=false where affiliate_partner_id=p_user_id;
  end if;
end $$;

create or replace function public.affiliate_admin_list_coupons()
returns table(code text,discount_percent integer,is_active boolean,affiliate_partner_id uuid,
  partner_name text,commission_percent numeric)
language plpgsql stable security definer
set search_path = public, auth, pg_temp
as $$
begin
  if not public.has_perm('coupons.read') then raise exception 'Permission denied: coupons.read' using errcode='42501'; end if;
  return query select c.code::text,c.discount_percent::integer,coalesce(c.is_active,true),c.affiliate_partner_id,
    a.public_name,coalesce(c.affiliate_commission_percent,a.commission_percent)
  from public.coupons c left join public.affiliate_partners a on a.user_id=c.affiliate_partner_id
  order by c.code;
end $$;

create or replace function public.affiliate_admin_link_coupon(
  p_code text,p_partner_user_id uuid,p_commission_percent numeric default null
) returns void language plpgsql security definer
set search_path = public, auth, pg_temp
as $$
declare v_rate numeric; v_status text;
begin
  if not public.has_perm('coupons.write') then raise exception 'Permission denied: coupons.write' using errcode='42501'; end if;
  if p_partner_user_id is null then
    update public.coupons set affiliate_partner_id=null,affiliate_commission_percent=null where code=upper(btrim(p_code));
    if not found then raise exception 'Coupon not found' using errcode='P0002'; end if;
    return;
  end if;
  select status,commission_percent into v_status,v_rate from public.affiliate_partners where user_id=p_partner_user_id;
  if v_status is distinct from 'approved' then raise exception 'Approve collaborator before assigning a coupon' using errcode='22023'; end if;
  v_rate:=coalesce(p_commission_percent,v_rate);
  if v_rate not between 0 and 50 then raise exception 'Commission rate is out of range' using errcode='22023'; end if;
  update public.coupons set affiliate_partner_id=p_partner_user_id,affiliate_commission_percent=v_rate where code=upper(btrim(p_code));
  if not found then raise exception 'Coupon not found' using errcode='P0002'; end if;
end $$;

-- Resolve the coupon to an approved partner on order creation, not at payment
-- fulfillment. This pins owner + commission for the life of this checkout.
create or replace function public.affiliate_snapshot_order_partner()
returns trigger language plpgsql security definer
set search_path = public, auth, pg_temp
as $$
declare v_partner uuid; v_rate numeric;
begin
  new.affiliate_partner_id:=null;
  new.affiliate_commission_percent:=null;
  if nullif(btrim(new.coupon_code),'') is null then return new; end if;
  select c.affiliate_partner_id,coalesce(c.affiliate_commission_percent,a.commission_percent)
    into v_partner,v_rate from public.coupons c
    join public.affiliate_partners a on a.user_id=c.affiliate_partner_id and a.status='approved'
   where upper(c.code)=upper(btrim(new.coupon_code)) limit 1;
  if v_partner is not null and coalesce(v_rate,0)>0 then
    new.affiliate_partner_id:=v_partner;
    new.affiliate_commission_percent:=v_rate;
  end if;
  return new;
end $$;

drop trigger if exists trg_affiliate_snapshot_order_partner on public.payment_orders;
create trigger trg_affiliate_snapshot_order_partner before insert on public.payment_orders
for each row execute function public.affiliate_snapshot_order_partner();

-- Seven-day eligibility hold protects against refunds/chargebacks; commission
-- uses the exact captured amount after coupon from payment_grants.amount_paise.
create or replace function public.affiliate_capture_paid_sale()
returns trigger language plpgsql security definer
set search_path = public, auth, pg_temp
as $$
declare v_partner uuid; v_rate numeric; v_code text; v_order_code text;
begin
  v_code:=upper(nullif(btrim(new.coupon_code),''));
  if v_code is null or coalesce(new.amount_paise,0)<=0 or new.order_id is null then return new; end if;
  select o.affiliate_partner_id,o.affiliate_commission_percent,o.coupon_code
    into v_partner,v_rate,v_order_code from public.payment_orders o where o.order_id=new.order_id;
  if not found or v_partner is null or coalesce(v_rate,0)<=0 or upper(coalesce(v_order_code,''))<>v_code then return new; end if;
  insert into public.affiliate_commissions(partner_user_id,coupon_code,payment_id,order_id,plan_key,
    sale_amount_paise,commission_percent,commission_paise,eligible_at)
  values(v_partner,v_code,new.payment_id,new.order_id,new.plan_key,new.amount_paise,v_rate,
    round(new.amount_paise*v_rate/100.0)::bigint,coalesce(new.created_at,now())+interval '7 days')
  on conflict(payment_id) do nothing;
  return new;
end $$;

drop trigger if exists trg_affiliate_capture_paid_sale on public.payment_grants;
create trigger trg_affiliate_capture_paid_sale after insert on public.payment_grants
for each row execute function public.affiliate_capture_paid_sale();

create or replace function public.affiliate_admin_create_sunday_payout_run()
returns uuid language plpgsql security definer
set search_path = public, auth, pg_temp
as $$
declare v_batch uuid; v_today date; v_period_start date; v_period_end date; v_partner record; v_payout uuid; v_count integer:=0;
begin
  if not public.has_perm('payments.write') then raise exception 'Permission denied: payments.write' using errcode='42501'; end if;
  v_today:=(now() at time zone 'Asia/Kolkata')::date;
  if extract(isodow from v_today)<>7 then raise exception 'Weekly payouts can only be prepared on Sunday (India time)' using errcode='22023'; end if;
  v_period_end:=v_today; v_period_start:=v_today-6;
  insert into public.affiliate_payout_batches(period_start,period_end,created_by)
  values(v_period_start,v_period_end,auth.uid()) returning id into v_batch;
  for v_partner in
    select c.partner_user_id,sum(c.commission_paise)::bigint amount,count(*)::integer n
      from public.affiliate_commissions c
     where c.status in ('pending','approved') and c.payout_id is null and c.eligible_at<=now()
     group by c.partner_user_id having sum(c.commission_paise)>0
  loop
    insert into public.affiliate_payouts(batch_id,partner_user_id,amount_paise,commissions_count)
    values(v_batch,v_partner.partner_user_id,v_partner.amount,v_partner.n) returning id into v_payout;
    update public.affiliate_commissions set status='approved',payout_id=v_payout
     where partner_user_id=v_partner.partner_user_id and status in ('pending','approved')
       and payout_id is null and eligible_at<=now();
    v_count:=v_count+1;
  end loop;
  if v_count=0 then raise exception 'No eligible unpaid commissions are due today' using errcode='P0002'; end if;
  return v_batch;
end $$;

create or replace function public.affiliate_admin_list_payouts()
returns table(payout_id uuid,batch_id uuid,period_start date,period_end date,partner_user_id uuid,
  partner_name text,payout_upi text,amount_paise bigint,commissions_count integer,status text,
  payment_reference text,paid_at timestamptz,created_at timestamptz)
language plpgsql stable security definer
set search_path = public, auth, pg_temp
as $$
begin
  if not public.has_perm('payments.read') then raise exception 'Permission denied: payments.read' using errcode='42501'; end if;
  return query select p.id,p.batch_id,b.period_start,b.period_end,p.partner_user_id,a.public_name,a.payout_upi,
    p.amount_paise,p.commissions_count,p.status,p.payment_reference,p.paid_at,p.created_at
  from public.affiliate_payouts p join public.affiliate_payout_batches b on b.id=p.batch_id
  join public.affiliate_partners a on a.user_id=p.partner_user_id order by p.created_at desc;
end $$;

create or replace function public.affiliate_admin_mark_payout(
  p_payout_id uuid,p_status text,p_payment_reference text default null
) returns void language plpgsql security definer
set search_path = public, auth, pg_temp
as $$
declare v_row public.affiliate_payouts%rowtype;
begin
  if not public.has_perm('payments.write') then raise exception 'Permission denied: payments.write' using errcode='42501'; end if;
  if p_status not in ('paid','failed') then raise exception 'Status must be paid or failed' using errcode='22023'; end if;
  if p_status='paid' and nullif(btrim(p_payment_reference),'') is null then raise exception 'Add RazorpayX/bank transfer reference before marking paid' using errcode='22023'; end if;
  select * into v_row from public.affiliate_payouts where id=p_payout_id for update;
  if not found then raise exception 'Payout not found' using errcode='P0002'; end if;
  if v_row.status<>'pending' then raise exception 'Payout is already finalized' using errcode='22023'; end if;
  update public.affiliate_payouts set status=p_status,payment_reference=nullif(left(btrim(coalesce(p_payment_reference,'')),120),''),
    paid_at=case when p_status='paid' then now() else null end,updated_at=now() where id=p_payout_id;
  if p_status='paid' then
    update public.affiliate_commissions set status='paid' where payout_id=p_payout_id and status='approved';
  else
    update public.affiliate_commissions set status='approved',payout_id=null where payout_id=p_payout_id and status='approved';
  end if;
  update public.affiliate_payout_batches set status='complete'
   where id=v_row.batch_id and not exists (
     select 1 from public.affiliate_payouts p where p.batch_id=v_row.batch_id and p.status='pending'
   );
end $$;

create or replace function public.affiliate_admin_list_commissions()
returns table(payment_id text,partner_user_id uuid,partner_name text,coupon_code text,plan_key text,
  sale_amount_paise bigint,commission_percent numeric,commission_paise bigint,status text,
  eligible_at timestamptz,created_at timestamptz)
language plpgsql stable security definer
set search_path = public, auth, pg_temp
as $$
begin
  if not public.has_perm('payments.read') then raise exception 'Permission denied: payments.read' using errcode='42501'; end if;
  return query select c.payment_id,c.partner_user_id,a.public_name,c.coupon_code,c.plan_key,
    c.sale_amount_paise,c.commission_percent,c.commission_paise,c.status,c.eligible_at,c.created_at
  from public.affiliate_commissions c join public.affiliate_partners a on a.user_id=c.partner_user_id
  order by c.created_at desc limit 500;
end $$;

create or replace function public.affiliate_admin_adjust_commission(
  p_payment_id text,p_new_sale_amount_paise bigint,p_reason text
) returns void language plpgsql security definer
set search_path = public, auth, pg_temp
as $$
declare v_row public.affiliate_commissions%rowtype; v_new_commission bigint;
begin
  if not public.has_perm('payments.write') then raise exception 'Permission denied: payments.write' using errcode='42501'; end if;
  if p_new_sale_amount_paise is null or p_new_sale_amount_paise<0 then raise exception 'Net paid amount must be zero or more paise' using errcode='22023'; end if;
  select * into v_row from public.affiliate_commissions where payment_id=p_payment_id for update;
  if not found then raise exception 'Commission not found' using errcode='P0002'; end if;
  if v_row.status not in ('pending','approved') or v_row.payout_id is not null then
    raise exception 'Only unpaid, unbatched commissions can be adjusted; release any payout run first' using errcode='22023';
  end if;
  if p_new_sale_amount_paise>v_row.sale_amount_paise then raise exception 'Adjusted amount cannot exceed original captured sale' using errcode='22023'; end if;
  v_new_commission:=round(p_new_sale_amount_paise*v_row.commission_percent/100.0)::bigint;
  update public.affiliate_commissions set sale_amount_paise=p_new_sale_amount_paise,
    commission_paise=v_new_commission,
    status=case when p_new_sale_amount_paise=0 then 'reversed' else status end,
    reversed_at=case when p_new_sale_amount_paise=0 then now() else null end,
    reversal_reason=case when p_new_sale_amount_paise=0 then left(coalesce(p_reason,'Full refund'),300) else null end,
    adjustment_reason=left(coalesce(p_reason,'Refund adjustment'),300)
   where payment_id=p_payment_id;
end $$;

create or replace function public.affiliate_admin_reverse_commission(
  p_payment_id text,p_reason text
) returns void language plpgsql security definer
set search_path = public, auth, pg_temp
as $$
declare v_row public.affiliate_commissions%rowtype;
begin
  if not public.has_perm('payments.write') then raise exception 'Permission denied: payments.write' using errcode='42501'; end if;
  select * into v_row from public.affiliate_commissions where payment_id=p_payment_id for update;
  if not found then return; end if;
  if v_row.status='paid' then raise exception 'Already-paid commission requires a future balance adjustment; do not silently edit it' using errcode='22023'; end if;
  if v_row.payout_id is not null then raise exception 'This commission is in a payout queue. Mark that transfer failed first, then reverse the sale.' using errcode='22023'; end if;
  update public.affiliate_commissions set status='reversed',reversed_at=now(),reversal_reason=left(coalesce(p_reason,'Refund/chargeback'),300),payout_id=null where payment_id=p_payment_id;
end $$;

revoke all on function public.affiliate_apply(text,text,text,boolean) from public, anon;
revoke all on function public.affiliate_partner_dashboard() from public, anon;
revoke all on function public.affiliate_admin_list_partners() from public, anon;
revoke all on function public.affiliate_admin_review_partner(uuid,text,numeric,integer,text) from public, anon;
revoke all on function public.affiliate_admin_list_coupons() from public, anon;
revoke all on function public.affiliate_admin_link_coupon(text,uuid,numeric) from public, anon;
revoke all on function public.affiliate_admin_create_sunday_payout_run() from public, anon;
revoke all on function public.affiliate_admin_list_payouts() from public, anon;
revoke all on function public.affiliate_admin_mark_payout(uuid,text,text) from public, anon;
revoke all on function public.affiliate_admin_list_commissions() from public, anon;
revoke all on function public.affiliate_admin_adjust_commission(text,bigint,text) from public, anon;
revoke all on function public.affiliate_admin_reverse_commission(text,text) from public, anon;
revoke all on function public.affiliate_snapshot_order_partner() from public, anon, authenticated;
revoke all on function public.affiliate_capture_paid_sale() from public, anon, authenticated;
grant execute on function public.affiliate_apply(text,text,text,boolean) to authenticated;
grant execute on function public.affiliate_partner_dashboard() to authenticated;
grant execute on function public.affiliate_admin_list_partners() to authenticated;
grant execute on function public.affiliate_admin_review_partner(uuid,text,numeric,integer,text) to authenticated;
grant execute on function public.affiliate_admin_list_coupons() to authenticated;
grant execute on function public.affiliate_admin_link_coupon(text,uuid,numeric) to authenticated;
grant execute on function public.affiliate_admin_create_sunday_payout_run() to authenticated;
grant execute on function public.affiliate_admin_list_payouts() to authenticated;
grant execute on function public.affiliate_admin_mark_payout(uuid,text,text) to authenticated;
grant execute on function public.affiliate_admin_list_commissions() to authenticated;
grant execute on function public.affiliate_admin_adjust_commission(text,bigint,text) to authenticated;
grant execute on function public.affiliate_admin_reverse_commission(text,text) to authenticated;

commit;
notify pgrst, 'reload schema';
