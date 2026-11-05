Deployed `ri-signup` edge function: creates an instantly-confirmed email+password account via the admin API
(same approach as Stars & Shade's `signup`), logs the IP (10 new accounts/IP/day), and creates the `ri_profiles` row
with the phone and company. Source is in the Supabase dashboard (Edge Functions → ri-signup).
