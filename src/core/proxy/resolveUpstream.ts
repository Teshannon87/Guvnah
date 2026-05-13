import type { GuvnahConfig } from "../config/schema.js";

export interface ResolvedUpstream {
  name: string;
  base_url: string;
  api_key_env?: string;
  auth: "bearer" | "x-api-key" | "none";
  extra_headers: Record<string, string>;
  forwarded_model: string;
  source: "model_prefix" | "default_upstream" | "legacy";
}

export interface LegacyUpstream {
  name: "legacy";
  base_url: string;
  api_key_env: string;
  auth: "bearer";
  extra_headers: Record<string, string>;
  forwarded_model: string;
  source: "legacy";
  forward_client_auth: boolean;
}

function fromLegacy(
  config: GuvnahConfig,
  model: string | null,
): LegacyUpstream {
  return {
    name: "legacy",
    base_url: config.upstream.base_url,
    api_key_env: config.upstream.api_key_env,
    auth: "bearer",
    extra_headers: {},
    forwarded_model: model ?? "",
    source: "legacy",
    forward_client_auth: config.upstream.forward_client_auth,
  };
}

export function resolveUpstream(
  model: string | null,
  config: GuvnahConfig,
): ResolvedUpstream | LegacyUpstream {
  const upstreams = config.upstreams ?? {};
  const hasUpstreamsMap = Object.keys(upstreams).length > 0;

  // Try model-prefix routing first when an upstreams map is configured.
  if (model && hasUpstreamsMap) {
    const slash = model.indexOf("/");
    if (slash > 0) {
      const prefix = model.slice(0, slash);
      const rest = model.slice(slash + 1);
      const hit = upstreams[prefix];
      if (hit) {
        return {
          name: prefix,
          base_url: hit.base_url,
          api_key_env: hit.api_key_env,
          auth: hit.auth,
          extra_headers: hit.extra_headers ?? {},
          forwarded_model: rest,
          source: "model_prefix",
        };
      }
    }
  }

  // Fall back to default_upstream if set.
  if (hasUpstreamsMap && config.default_upstream) {
    const hit = upstreams[config.default_upstream];
    if (hit) {
      return {
        name: config.default_upstream,
        base_url: hit.base_url,
        api_key_env: hit.api_key_env,
        auth: hit.auth,
        extra_headers: hit.extra_headers ?? {},
        forwarded_model: model ?? "",
        source: "default_upstream",
      };
    }
  }

  // Backwards compatibility: legacy single-`upstream` config.
  return fromLegacy(config, model);
}
