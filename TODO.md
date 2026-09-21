# Voluntio delivery tracker

This tracker keeps the larger requested refresh bounded and verifiable. Items are grouped by dependency and should be completed and tested in order.

## 1. Access, security, and navigation

- [x] Correct the password-visibility control and its accessible state.
- [x] Send email confirmation to the current deployed origin (Supabase allow-list still required).
- [x] Centre the navigation regardless of whether the admin link is available.
- [x] Verify page guards and role boundaries: admins moderate site content; event creators manage their own events.

## 2. Core event flows

- [ ] Repair event discovery filters and weekly/event counts.
- [x] Direct creators to the newly created event; direct edits to the relevant event.
- [x] Require a requested role for applications, validate role capacity, and show accurate `filled/total` counts.
- [x] Hide event chat composition from non-participants and provide a clear join prompt.
- [x] Restore admin event-list rendering while retaining moderation-only permissions.

## 3. Layout and content polish

- [x] Centre profile and event-form text where appropriate.
- [x] Make the desktop home hero fill the initial viewport and remove the title rule.
- [x] Rebuild the event page into a cohesive full-width event detail experience.
- [ ] Add the requested event details, organizer controls, updates, and recognition surfaces where supported by the data model.

## 4. Deployment checks

- [ ] Review schema/RLS and configuration prerequisites.
- [ ] Run available static and application checks; document anything needing Supabase-dashboard configuration.
