-- Fix affiliate admin partner listing: SUM(bigint) returns numeric in PostgreSQL,
-- while the table-returning RPC declares these aggregate columns as bigint.
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
    (select count(*) from public.affiliate_commissions c where c.partner_user_id=a.user_id and c.status<>'reversed')::bigint,
    (select coalesce(sum(c.commission_paise),0)::bigint from public.affiliate_commissions c where c.partner_user_id=a.user_id and c.status='pending'),
    (select coalesce(sum(c.commission_paise),0)::bigint from public.affiliate_commissions c where c.partner_user_id=a.user_id and c.status='approved' and c.payout_id is null),
    (select coalesce(sum(c.commission_paise),0)::bigint from public.affiliate_commissions c where c.partner_user_id=a.user_id and c.status='paid')
  from public.affiliate_partners a left join auth.users u on u.id=a.user_id order by a.applied_at desc;
end $$;

revoke all on function public.affiliate_admin_list_partners() from public, anon;
grant execute on function public.affiliate_admin_list_partners() to authenticated;
