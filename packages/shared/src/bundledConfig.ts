/**
 * The production Supabase project's public connection values, shared by the agent
 * (`packages/agent/src/config.ts`, bundled into every `npm i -g loadout-agent` install) and
 * the dashboard's `/start` page (which uses these to decide whether it needs to show anyone
 * the manual `export` step at all). One copy, not two hand-kept ones.
 *
 * Both values are public by design: the URL is a hostname, and the anon key is a client
 * credential whose whole security model is row-level security on the other side.
 */
export const BUNDLED_SUPABASE_URL = "https://wkqopvhqiqxnbswrdxlf.supabase.co";
export const BUNDLED_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndrcW9wdmhxaXF4bmJzd3JkeGxmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg2NTkwODgsImV4cCI6MjEwNDIzNTA4OH0.Jb3Qf7YyqYpMSiWO5zVBeD3AEYUIcuJ4P7JUtibrMso";
