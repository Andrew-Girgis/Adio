-- Upgrade YouTube guide tables for URL-first caption extraction cache.

alter table if exists public.video_sources
  add column if not exists youtube_video_id text,
  add column if not exists normalized_url text,
  add column if not exists last_extracted_at timestamptz;

create unique index if not exists idx_video_sources_youtube_video_id
  on public.video_sources (youtube_video_id)
  where youtube_video_id is not null;

create index if not exists idx_video_sources_normalized_url
  on public.video_sources (normalized_url);

alter table if exists public.video_transcripts
  add column if not exists language_code text,
  add column if not exists extraction_source text,
  add column if not exists cleaned_text text,
  add column if not exists extraction_status text,
  add column if not exists error_message text,
  add column if not exists updated_at timestamptz default now();

update public.video_transcripts
set language_code = coalesce(nullif(language_code, ''), 'unknown')
where language_code is null or language_code = '';

update public.video_transcripts
set extraction_source = coalesce(nullif(extraction_source, ''), 'manual')
where extraction_source is null or extraction_source = '';

update public.video_transcripts
set extraction_status = coalesce(nullif(extraction_status, ''), 'ready')
where extraction_status is null or extraction_status = '';

alter table if exists public.video_transcripts
  alter column language_code set default 'unknown',
  alter column language_code set not null,
  alter column extraction_source set default 'manual',
  alter column extraction_source set not null,
  alter column extraction_status set default 'ready',
  alter column extraction_status set not null,
  alter column updated_at set default now(),
  alter column updated_at set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'video_transcripts_extraction_source_check'
  ) then
    alter table public.video_transcripts
      add constraint video_transcripts_extraction_source_check
      check (extraction_source in ('ytdlp', 'n8n', 'manual'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'video_transcripts_extraction_status_check'
  ) then
    alter table public.video_transcripts
      add constraint video_transcripts_extraction_status_check
      check (extraction_status in ('ready', 'failed'));
  end if;
end
$$;

create unique index if not exists idx_video_transcripts_video_language
  on public.video_transcripts (video_id, language_code);

alter table if exists public.video_procedures
  add column if not exists transcript_id uuid references public.video_transcripts(id) on delete cascade,
  add column if not exists compiler_version text;

update public.video_procedures
set compiler_version = coalesce(nullif(compiler_version, ''), 'v1')
where compiler_version is null or compiler_version = '';

alter table if exists public.video_procedures
  alter column compiler_version set default 'v1',
  alter column compiler_version set not null;

create unique index if not exists idx_video_procedures_transcript_compiler
  on public.video_procedures (transcript_id, compiler_version)
  where transcript_id is not null;
