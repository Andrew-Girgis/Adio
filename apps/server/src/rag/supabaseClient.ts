import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { AppConfig } from "../config";

export function isSupabaseRagConfigured(config: AppConfig): boolean {
  return Boolean(config.supabaseUrl && config.supabaseServiceRoleKey);
}

export function createSupabaseServiceClient(config: AppConfig): SupabaseClient | null {
  if (!isSupabaseRagConfigured(config)) {
    return null;
  }

  return createClient(config.supabaseUrl as string, config.supabaseServiceRoleKey as string, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    },
    global: {
      headers: {
        "x-adio-service": "manual-rag"
      }
    }
  });
}
