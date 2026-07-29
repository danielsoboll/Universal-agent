-- Fix: INSERT...RETURNING failed because SELECT RLS ran before AFTER INSERT
-- trigger could create project_members. Owners must see their own rows via owner_id.
-- Cause of Vercel "server error" on /projects/new.

drop policy if exists projects_select on public.projects;

create policy projects_select on public.projects
  for select to authenticated
  using (
    owner_id = auth.uid()
    or public.is_project_member(id)
  );

-- Allow bootstrap owner membership without chicken/egg if trigger is bypassed.
drop policy if exists project_members_insert on public.project_members;

create policy project_members_insert on public.project_members
  for insert to authenticated
  with check (
    public.is_project_owner(project_id)
    or (
      user_id = auth.uid()
      and role = 'owner'
      and is_active = true
      and exists (
        select 1
        from public.projects as p
        where p.id = project_id
          and p.owner_id = auth.uid()
      )
    )
  );
