-- Run this in your Supabase SQL Editor to set up the CSR Agent schema.

-- Categories (synced from each agent's local store)
create table if not exists public.categories (
  id           text primary key,
  agent_id     text not null,
  name         text not null,
  "order"      integer default 0,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

-- Buttons (synced from each agent's local store)
create table if not exists public.buttons (
  id           uuid primary key,
  agent_id     text not null,
  name         text not null,
  category     text default '',
  type         text default 'call_control',
  coordinates  jsonb,
  active       boolean default true,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

-- Add missing 'order' column to buttons if it already exists
alter table public.buttons add column if not exists "order" integer default 0;

-- Commands (dashboard inserts a row here to trigger a remote click)
create table if not exists public.commands (
  id           uuid primary key default gen_random_uuid(),
  agent_id     text not null,
  button_id    uuid references public.buttons(id),
  button_name  text,
  status       text default 'pending',   -- pending | done | error
  requested_by text,
  error_message text,
  created_at   timestamptz default now(),
  executed_at  timestamptz
);

-- Add missing columns to commands if it already exists
alter table public.commands add column if not exists requested_by text;
alter table public.commands add column if not exists error_message text;

-- Enable Realtime for buttons, categories and commands
do $$
begin
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'buttons') then
        alter publication supabase_realtime add table public.buttons;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'categories') then
        alter publication supabase_realtime add table public.categories;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'commands') then
        alter publication supabase_realtime add table public.commands;
    end if;
end $$;

-- Permissive RLS (tighten per your security needs)
alter table public.categories enable row level security;
alter table public.buttons enable row level security;
alter table public.commands enable row level security;

-- Drop policies before recreating to avoid "already exists" errors
drop policy if exists "allow_all" on public.categories;
drop policy if exists "allow_all" on public.buttons;
drop policy if exists "allow_all" on public.commands;

create policy "allow_all" on public.categories for all using (true) with check (true);
create policy "allow_all" on public.buttons for all using (true) with check (true);
create policy "allow_all" on public.commands for all using (true) with check (true);
