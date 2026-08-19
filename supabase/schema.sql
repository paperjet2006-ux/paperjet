-- PaperJET — database schema
--
-- Captured from the live project on 2026-08-19. Run once, in the SQL Editor
-- of a fresh PaperJET Supabase project.
--
-- The key in public/js/config.js is a *publishable* key: anyone can read it
-- out of the page source. The security boundary is therefore row-level
-- security, not the key, and every policy below is load-bearing.
--
-- Two ideas run through it:
--   1. Anonymous visitors may INSERT, never SELECT. A visitor can log a run
--      or answer the survey, but cannot read anybody's rows back — which
--      matters because survey_responses holds email addresses.
--   2. Signed-in users may read only their own rows (user_id = auth.uid()).
--
-- The CHECK constraints are not cosmetic either. These are public write
-- endpoints, so the length caps are what stop someone posting megabyte
-- strings into the tables.


-- ── tool_runs ────────────────────────────────────────────────────────────
-- One row per tool run: which tool, and when. user_id is null for the
-- signed-out majority, which is the normal case rather than an error.

create table if not exists public.tool_runs (
    id         bigserial primary key,
    tool       text not null check (char_length(tool) between 1 and 40),
    user_id    uuid references auth.users (id) on delete set null,
    created_at timestamptz not null default now()
);

alter table public.tool_runs enable row level security;

create policy tool_runs_insert_any on public.tool_runs
    for insert to anon, authenticated with check (true);

create policy tool_runs_read_own on public.tool_runs
    for select to authenticated using (user_id = auth.uid());


-- ── survey_responses ─────────────────────────────────────────────────────
-- The optional "who are you, and what is this for?" prompt. Every column is
-- nullable because every question is skippable.

create table if not exists public.survey_responses (
    id          bigserial primary key,
    industry    text    check (industry   is null or char_length(industry)   <= 60),
    use_case    text    check (use_case   is null or char_length(use_case)   <= 60),
    first_tool  text    check (first_tool is null or char_length(first_tool) <= 40),
    name        text    check (name       is null or char_length(name)       <= 120),
    email       text    check (email      is null or char_length(email)      <= 200),
    company     text    check (company    is null or char_length(company)    <= 160),
    country     text    check (country    is null or char_length(country)    <= 60),
    city        text    check (city       is null or char_length(city)       <= 80),
    consented   boolean not null default false,
    created_at  timestamptz not null default now()
);

alter table public.survey_responses enable row level security;

-- Consent enforced by the database, not merely by the form: a row carrying
-- personal details is rejected outright unless consented is true. Anonymous
-- answers (industry / use_case only) are always allowed.
create policy survey_insert_any on public.survey_responses
    for insert to anon, authenticated
    with check (
        consented = true
        or (name is null and email is null and company is null)
    );


-- ── subscribers ──────────────────────────────────────────────────────────
-- Signed-in users who opted in to hearing about new tools. One row per user;
-- each may read and amend only their own.

create table if not exists public.subscribers (
    user_id    uuid primary key references auth.users (id) on delete cascade,
    email      text,
    consented  boolean not null default false,
    created_at timestamptz not null default now()
);

alter table public.subscribers enable row level security;

create policy subscribers_write_own on public.subscribers
    for insert to authenticated with check (user_id = auth.uid());

create policy subscribers_read_own on public.subscribers
    for select to authenticated using (user_id = auth.uid());

create policy subscribers_update_own on public.subscribers
    for update to authenticated using (user_id = auth.uid());


-- ── grants ───────────────────────────────────────────────────────────────
-- Necessary, and easy to miss: a policy permits, but the role must also hold
-- the underlying SQL privilege. Without these every request fails with
-- "permission denied for table" rather than an RLS rejection. Older Supabase
-- projects granted anon everything by default and leaned on RLS alone; newer
-- ones grant nothing, so this must be explicit.
--
-- Each grant is the minimum the policies above actually use, so the two
-- agree. Should RLS ever be disabled by accident, anon still cannot read or
-- delete anything.

grant insert          on public.tool_runs         to anon, authenticated;
grant select          on public.tool_runs         to authenticated;
grant insert          on public.survey_responses  to anon, authenticated;
grant select, insert, update on public.subscribers to authenticated;

-- bigserial primary keys draw from a sequence, and inserting requires USAGE
-- on it — otherwise the insert is refused despite the table grant above.
grant usage on sequence public.tool_runs_id_seq        to anon, authenticated;
grant usage on sequence public.survey_responses_id_seq to anon, authenticated;
