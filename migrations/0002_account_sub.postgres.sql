-- A person's warOnSaaS account id (the ID token's sub), set when the hosted copy signs them in with the account.
alter table chat_people add column if not exists sub text;
create index if not exists chat_people_sub on chat_people (sub) where sub is not null;
