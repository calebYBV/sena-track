import { SUPABASE_CONFIG } from "./supabaseConfig.js";

let clientPromise;

export function isSupabaseConfigured(){
  return Boolean(SUPABASE_CONFIG.projectUrl && SUPABASE_CONFIG.publishableKey);
}

export async function getSupabaseClient(){
  if (!isSupabaseConfigured()){
    throw new Error("Completa projectUrl y publishableKey en js/supabaseConfig.js.");
  }
  if (!clientPromise){
    clientPromise = import("https://esm.sh/@supabase/supabase-js@2").then(({ createClient }) =>
      createClient(SUPABASE_CONFIG.projectUrl, SUPABASE_CONFIG.publishableKey, {
        auth: {
          autoRefreshToken: true,
          detectSessionInUrl: true,
          persistSession: true
        }
      })
    );
  }
  return clientPromise;
}
