-- Monthly plan: 15 interviews per billing month (was 60).
update ip_private.settings set value = '15' where key = 'monthly_limit';
