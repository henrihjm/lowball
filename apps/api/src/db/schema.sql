-- Lowball schema (Neon Postgres). Idempotent: safe to run more than once.

create table if not exists users (
  id text primary key default 'henri',
  telegram_chat_id bigint,
  neighborhood text,
  pickup_windows text,           -- free text, e.g. "Tue/Thu 18:00-20:00, Sat 10:00-12:00"
  payment_methods text,          -- "cash or Venmo @henri"
  meeting_spot text              -- "building lobby, 1234 X St"
);

create table if not exists items (
  id uuid primary key default gen_random_uuid(),
  user_id text references users(id),
  status text not null default 'draft',   -- draft|listed|pending|sold|paused|deleted
  title text, description text, condition_notes text,
  photos jsonb,                            -- [{telegram_file_id, url}]
  ask_cents int, floor_cents int,
  decay_pct numeric default 7, decay_every_days int default 3,
  listed_at timestamptz, sold_at timestamptz, sold_cents int,
  inbox_id text, inbox_address text,       -- AgentMail inbox used as the Craigslist poster email
  craigslist_url text, ebay_url text,
  comps jsonb,                             -- [{title,price_cents,url,source}]
  created_at timestamptz default now()
);
alter table items add column if not exists kernel_live_view_url text;
alter table items add column if not exists card_message_id bigint;      -- Telegram proposal card

create table if not exists buyers (
  id uuid primary key default gen_random_uuid(),
  item_id uuid references items(id),
  email text not null,                     -- Craigslist relay address or direct
  display_name text,
  thread_id text,                          -- AgentMail thread id
  status text not null default 'active',   -- active|blocked|confirmed|backup|noshow|closed
  score numeric default 0,
  counters_used int default 0,
  last_offer_cents int,
  first_seen timestamptz default now(),
  last_inbound timestamptz, last_outbound timestamptz,
  scam_flags jsonb default '[]',
  proposed_time text,                      -- buyer's stated availability (free text)
  unique (item_id, email)
);
alter table buyers add column if not exists last_counter_cents int;     -- our last counter, never raised
alter table buyers add column if not exists agreed_cents int;           -- price accepted through acceptOffer
alter table buyers add column if not exists proposed_at timestamptz;    -- buyer's stated time, resolved

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  buyer_id uuid references buyers(id),
  direction text not null,                 -- in|out
  agentmail_message_id text,
  body text,
  intent text,                             -- availability|offer|question|schedule|scam|other
  offer_cents int,
  reasoning text,                          -- the negotiator's one-line reasoning (shown on the board)
  floor_at_time_cents int,
  created_at timestamptz default now()
);
alter table messages add column if not exists ask_at_time_cents int;
alter table messages add column if not exists handled_at timestamptz;   -- inbound: when the pipeline finished
create unique index if not exists messages_agentmail_message_id_key on messages (agentmail_message_id);
create index if not exists messages_buyer_created_idx on messages (buyer_id, created_at);

create table if not exists slots (
  id uuid primary key default gen_random_uuid(),
  item_id uuid references items(id),
  buyer_id uuid references buyers(id),
  starts_at timestamptz not null,
  status text not null default 'proposed', -- proposed|confirmed|address_sent|reminded|completed|noshow
  address_sent_at timestamptz
);
alter table slots add column if not exists buyer_confirmed_at timestamptz; -- buyer answered the reminder

create table if not exists decisions (     -- interrupts sent to Henri on Telegram
  id uuid primary key default gen_random_uuid(),
  item_id uuid, buyer_id uuid,
  kind text not null,                      -- below_floor|slot_conflict|scam_unsure|noshow|sold_check
  payload jsonb,
  options jsonb,                           -- [{key,label}]
  chosen text, resolved_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists clocks (        -- scheduler queue
  id uuid primary key default gen_random_uuid(),
  due_at timestamptz not null,
  kind text not null,                      -- send_address|remind_buyer|check_noshow|digest|decay|sold_check
  payload jsonb,
  done_at timestamptz
);
create index if not exists clocks_due_idx on clocks (due_at) where done_at is null;

insert into users (id) values ('henri') on conflict (id) do nothing;

-- Where the ad is (or should be) listed: [{name, url, why, status}] with status ready|live|sold.
alter table items add column if not exists channels jsonb;
