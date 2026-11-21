-- 3 free interviews per account (was 1). New sign-ups get 3 from the trigger in billing.sql;
-- existing accounts get the 2 extra, so everyone has had 3 in total.
update ip_private.settings set value = '3' where key = 'free_credits';
update public.ip_accounts set credits = credits + 2, updated_at = now()
  where coalesce((select value from ip_private.settings where key = 'free_interviews_topped_up'), '') <> 'yes';
insert into ip_private.settings values ('free_interviews_topped_up', 'yes')
  on conflict (key) do update set value = 'yes';
