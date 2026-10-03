import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "npm:@supabase/server@1";

export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    if (req.method !== "GET") {
      return new Response(JSON.stringify({ error: "method_not_allowed" }), {
        status: 405,
        headers: { "content-type": "application/json", "allow": "GET" },
      });
    }

    const userId = ctx.user?.id;
    if (!userId) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }

    const [profileResult, settingsResult] = await Promise.all([
      ctx.supabase.from("profiles").select("id,display_name,created_at,updated_at").eq("id", userId).maybeSingle(),
      ctx.supabase.from("user_settings").select(
        "user_id,theme,remember_context,notifications_email,notifications_in_app,save_history,response_style,use_name_in_responses,suggest_mentors,created_at,updated_at"
      ).eq("user_id", userId).maybeSingle(),
    ]);

    if (profileResult.error || settingsResult.error) {
      return new Response(JSON.stringify({ error: "profile_load_failed" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(JSON.stringify({
      user: { id: userId },
      profile: profileResult.data,
      settings: settingsResult.data,
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "private, no-store",
      },
    });
  }),
};