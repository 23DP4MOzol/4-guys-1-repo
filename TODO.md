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

## Current layout follow-up

- [x] Replace conflicting desktop navbar positioning with a final centered rule.
- [x] Add a full-width event-creation layout with address suggestions and map selection.
- [x] Store selected coordinates and render the event map beside the conversation.
- [x] Add community statistics to the home hero and a wide profile hero.
- [x] Rebuild the event detail into a non-overlapping two-column workspace.
- [x] Remove duplicate event description content and add organizer/participant panels with avatar fallbacks.
- [x] Add organizer event controls: edit, cancel, approve/reject, mute/unmute, remove participant, and delete messages.
- [x] Add editable profile avatars and remove the redundant account-delete trigger.
- [x] Remove the create-event card overlap, enable intentional map-wheel zoom, and block past event dates.
