create table if not exists public.video_sources (
  id uuid primary key default gen_random_uuid(),
  url text,
  title text,
  created_at timestamptz not null default now()
);

create table if not exists public.video_transcripts (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references public.video_sources(id) on delete cascade,
  raw_text text not null,
  segments_json jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.video_procedures (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references public.video_sources(id) on delete cascade,
  tools_json jsonb not null,
  procedure_json jsonb not null,
  safety_flags_json jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_video_transcripts_video_id on public.video_transcripts(video_id);
create index if not exists idx_video_procedures_video_id on public.video_procedures(video_id);
