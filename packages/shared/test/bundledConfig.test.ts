import { describe, it, expect } from "vitest";
import { BUNDLED_SUPABASE_URL, BUNDLED_SUPABASE_ANON_KEY } from "../src/bundledConfig";

describe("bundled Supabase config", () => {
  it("exports the production project URL", () => {
    expect(BUNDLED_SUPABASE_URL).toBe("https://wkqopvhqiqxnbswrdxlf.supabase.co");
  });

  it("exports the production anon key", () => {
    expect(BUNDLED_SUPABASE_ANON_KEY).toBe(
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndrcW9wdmhxaXF4bmJzd3JkeGxmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg2NTkwODgsImV4cCI6MjEwNDIzNTA4OH0.Jb3Qf7YyqYpMSiWO5zVBeD3AEYUIcuJ4P7JUtibrMso"
    );
  });
});
