-- Выполни этот SQL в Supabase → SQL Editor.
-- Таблица хранит один JSON-документ бюджета на каждого авторизованного пользователя.

create table if not exists public.budget_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.budget_data enable row level security;

drop policy if exists "budget_data_select_own" on public.budget_data;
drop policy if exists "budget_data_insert_own" on public.budget_data;
drop policy if exists "budget_data_update_own" on public.budget_data;
drop policy if exists "budget_data_delete_own" on public.budget_data;

create policy "budget_data_select_own"
on public.budget_data
for select
to authenticated
using (auth.uid() = user_id);

create policy "budget_data_insert_own"
on public.budget_data
for insert
to authenticated
with check (auth.uid() = user_id);

create policy "budget_data_update_own"
on public.budget_data
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "budget_data_delete_own"
on public.budget_data
for delete
to authenticated
using (auth.uid() = user_id);
