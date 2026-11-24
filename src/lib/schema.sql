-- RaceKit Multi-User PostgreSQL Schema for Supabase
-- Run this in your Supabase SQL Editor: https://supabase.com/dashboard/project/_/sql

-- 1. Athlete Profiles
create table if not exists public.profiles (
  id uuid references auth.users on delete cascade primary key,
  email text not null,
  name text,
  avatar_url text,
  weekly_target_miles numeric default 30.0,
  longest_run_miles numeric default 10.0,
  garmlink_connected boolean default false,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable RLS
alter table public.profiles enable row level security;

create policy "Users can view own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = id);

create policy "Users can insert own profile"
  on public.profiles for insert
  with check (auth.uid() = id);

-- 2. User Workouts & Schedule
create table if not exists public.user_workouts (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users on delete cascade not null,
  plan_focus text not null,
  workouts jsonb not null default '{}'::jsonb,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null,
  unique (user_id, plan_focus)
);

alter table public.user_workouts enable row level security;

create policy "Users can view own workouts"
  on public.user_workouts for select
  using (auth.uid() = user_id);

create policy "Users can insert/update own workouts"
  on public.user_workouts for all
  using (auth.uid() = user_id);

-- 3. User PRs and Efforts
create table if not exists public.user_efforts (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users on delete cascade not null,
  efforts jsonb not null default '[]'::jsonb,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null,
  unique (user_id)
);

alter table public.user_efforts enable row level security;

create policy "Users can manage own efforts"
  on public.user_efforts for all
  using (auth.uid() = user_id);

-- 4. User Garmlink Watch Credentials (Encrypted)
create table if not exists public.user_garmlink_configs (
  user_id uuid references auth.users on delete cascade primary key,
  access_token text,
  api_key text,
  connected_at timestamp with time zone default timezone('utc'::text, now()) not null
);

alter table public.user_garmlink_configs enable row level security;

create policy "Users can manage own garmlink config"
  on public.user_garmlink_configs for all
  using (auth.uid() = user_id);
