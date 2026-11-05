-- Cole tudo isto no SQL Editor do Supabase e clique em "Run".

create table if not exists public.entities (
  room       text not null,
  id         text not null,
  kind       text not null,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (room, id)
);

create index if not exists entities_room_idx on public.entities (room);

-- Acesso: qualquer pessoa com o link da mesa pode ler e escrever.
-- (É uma mesa entre amigos; o "segredo" é o código da sala.)
alter table public.entities enable row level security;
drop policy if exists "mesa aberta" on public.entities;
create policy "mesa aberta" on public.entities
  for all to anon, authenticated using (true) with check (true);

-- Tempo real
alter table public.entities replica identity full;
do $$ begin
  alter publication supabase_realtime add table public.entities;
exception when duplicate_object then null; end $$;

-- Imagens (mapas e tokens)
insert into storage.buckets (id, name, public)
values ('mesa', 'mesa', true)
on conflict (id) do nothing;

drop policy if exists "mesa imagens ler" on storage.objects;
create policy "mesa imagens ler" on storage.objects
  for select to anon, authenticated using (bucket_id = 'mesa');

drop policy if exists "mesa imagens enviar" on storage.objects;
create policy "mesa imagens enviar" on storage.objects
  for insert to anon, authenticated with check (bucket_id = 'mesa');
