import { limitedText, redactSecrets } from './model.js';
import type { Config, Route } from './types.js';
import { resolveContextWindow } from './context-budget.js';

export type CredentialStatus = 'valid' | 'rejected' | 'missing' | 'unverified' | 'unreachable';

export interface RoutePreflightResult {
  route: 'executor' | 'reviewer';
  model: string;
  family: string;
  credentialEnv: string;
  credentialPresent: boolean;
  credentialStatus: CredentialStatus;
  readOnly: true;
  modelListed: boolean | 'unknown';
  contextWindowTokens: number | null;
  maxOutputTokens: number | null;
  limitSource: 'provider' | 'heuristic' | 'unverified';
  supportsTools: boolean | 'unknown';
  supportsReasoning: boolean | 'unknown';
  warnings: string[];
  error?: string;
}

export interface ProviderPreflightReport {
  readOnly: true;
  checkedAt: string;
  passed: boolean;
  executor: RoutePreflightResult;
  reviewer: RoutePreflightResult;
  warnings: string[];
}

function numericField(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === 'number' && Number.isFinite(val) && val > 0) return Math.floor(val);
  }
  return null;
}

function parseModelMetadata(entry: Record<string, unknown>, route: Route): {
  contextWindowTokens: number | null;
  maxOutputTokens: number | null;
  limitSource: 'provider' | 'heuristic' | 'unverified';
  supportsTools: boolean | 'unknown';
  supportsReasoning: boolean | 'unknown';
} {
  const top = (entry.top_provider && typeof entry.top_provider === 'object') ? entry.top_provider as Record<string, unknown> : {};
  const caps = (entry.capabilities && typeof entry.capabilities === 'object') ? entry.capabilities as Record<string, unknown> : {};
  const limits = (caps.limits && typeof caps.limits === 'object') ? caps.limits as Record<string, unknown> : {};

  const providerContext = numericField(entry, ['context_length', 'max_context_length', 'context_window', 'input_token_limit', 'max_input_tokens'])
    ?? numericField(top, ['context_length', 'max_context_length'])
    ?? numericField(limits, ['max_context_window_tokens', 'max_prompt_tokens']);

  const providerOutput = numericField(entry, ['max_output_tokens', 'max_completion_tokens', 'output_token_limit'])
    ?? numericField(top, ['max_completion_tokens', 'max_output_tokens'])
    ?? numericField(limits, ['max_output_tokens']);

  const params = Array.isArray(entry.supported_parameters)
    ? new Set(entry.supported_parameters.filter((p): p is string => typeof p === 'string').map(p => p.toLowerCase()))
    : null;

  let supportsTools: boolean | 'unknown' = 'unknown';
  if (typeof caps.function_calling === 'boolean') supportsTools = caps.function_calling;
  else if (typeof caps.tools === 'boolean') supportsTools = caps.tools;
  else if (typeof entry.supports_tools === 'boolean') supportsTools = entry.supports_tools;
  else if (params) supportsTools = params.has('tools') || params.has('tool_choice') || params.has('functions');

  let supportsReasoning: boolean | 'unknown' = 'unknown';
  if (typeof caps.reasoning === 'boolean') supportsReasoning = caps.reasoning;
  else if (typeof entry.supports_reasoning === 'boolean') supportsReasoning = entry.supports_reasoning;
  else if (params) supportsReasoning = params.has('reasoning') || params.has('reasoning_effort') || params.has('include_reasoning');

  return {
    contextWindowTokens: providerContext ?? route.contextWindowTokens ?? resolveContextWindow(route),
    maxOutputTokens: providerOutput,
    limitSource: providerContext ? 'provider' : route.contextWindowTokens ? 'heuristic' : 'unverified',
    supportsTools,
    supportsReasoning,
  };
}

/**
 * Read-only provider capability & credential probe via GET /models (never calls /chat/completions
 * and never infers credential validity from environment variable presence).
 */
export async function probeRouteCapabilities(
  role: 'executor' | 'reviewer',
  route: Route,
  options: { fetchImpl?: typeof fetch; maxBytes?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<RoutePreflightResult> {
  const key = process.env[route.apiKeyEnv];
  const base: RoutePreflightResult = {
    route: role,
    model: route.model,
    family: route.family,
    credentialEnv: route.apiKeyEnv,
    credentialPresent: !!key,
    credentialStatus: key ? 'unverified' : 'missing',
    readOnly: true,
    modelListed: 'unknown',
    contextWindowTokens: route.contextWindowTokens ?? resolveContextWindow(route),
    maxOutputTokens: null,
    limitSource: route.contextWindowTokens ? 'heuristic' : 'unverified',
    supportsTools: 'unknown',
    supportsReasoning: 'unknown',
    warnings: [],
  };

  if (!key) {
    base.error = `Missing credential environment variable: ${route.apiKeyEnv}`;
    return base;
  }

  let modelsUrl: URL;
  try {
    modelsUrl = new URL(route.baseUrl.replace(/\/$/, '') + '/models');
  } catch (error) {
    base.credentialStatus = 'unreachable';
    base.error = `Invalid baseUrl: ${String(error)}`;
    return base;
  }
  if (modelsUrl.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1', '[::1]'].includes(modelsUrl.hostname)) {
    base.credentialStatus = 'unreachable';
    base.error = 'Model endpoint requires HTTPS outside localhost';
    return base;
  }

  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? Math.min(route.requestTimeoutMs, 15000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);

  let response: Response;
  try {
    response = await doFetch(modelsUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal,
      redirect: 'error',
    });
  } catch (error) {
    base.credentialStatus = 'unreachable';
    base.error = redactSecrets(`Read-only capability probe failed: ${String(error)}`, [key]);
    return base;
  }

  if (response.status === 401 || response.status === 403) {
    base.credentialStatus = 'rejected';
    base.error = `Provider rejected credential (HTTP ${response.status}) during read-only /models probe`;
    return base;
  }

  if (response.status === 404 || response.status === 405) {
    base.credentialStatus = 'unverified';
    base.warnings.push(`Read-only /models endpoint returned HTTP ${response.status}; capabilities and credential validity remain unverified without dispatching a completion request.`);
    return base;
  }

  if (!response.ok) {
    base.credentialStatus = 'unverified';
    base.error = `Provider returned HTTP ${response.status} during read-only /models probe`;
    return base;
  }

  base.credentialStatus = 'valid';
  let payload: unknown;
  try {
    const body = await limitedText(response, Math.min(options.maxBytes ?? 2 * 1024 * 1024, 2 * 1024 * 1024));
    payload = JSON.parse(body);
  } catch (error) {
    base.warnings.push(`Model catalog response could not be parsed cleanly: ${redactSecrets(String(error), [key])}`);
    return base;
  }

  const list = Array.isArray((payload as { data?: unknown })?.data)
    ? (payload as { data: unknown[] }).data
    : Array.isArray(payload) ? payload : [];
  const entries = list.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object');
  const match = entries.find(item => item.id === route.model || item.name === route.model);

  if (!match) {
    base.modelListed = entries.length > 0 ? false : 'unknown';
    if (base.modelListed === false) {
      base.warnings.push(`Configured model "${route.model}" was not listed in provider /models catalog (${entries.length} models returned).`);
    }
    return base;
  }

  base.modelListed = true;
  const meta = parseModelMetadata(match, route);
  base.contextWindowTokens = meta.contextWindowTokens;
  base.maxOutputTokens = meta.maxOutputTokens;
  base.limitSource = meta.limitSource;
  base.supportsTools = meta.supportsTools;
  base.supportsReasoning = meta.supportsReasoning;

  if (role === 'executor' && meta.supportsTools === false) {
    base.warnings.push(`Executor model "${route.model}" reports tools/function-calling unsupported.`);
  }
  if (meta.contextWindowTokens && route.maxOutputTokens >= meta.contextWindowTokens) {
    base.warnings.push(`Configured maxOutputTokens (${route.maxOutputTokens}) meets or exceeds context window (${meta.contextWindowTokens}).`);
  }
  return base;
}

export async function preflightProvider(
  config: Config,
  options: { fetchImpl?: typeof fetch; maxBytes?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ProviderPreflightReport> {
  const executor = await probeRouteCapabilities('executor', config.executor, options);
  const sameRoute = JSON.stringify(config.executor) === JSON.stringify(config.reviewer);
  const reviewer = sameRoute
    ? { ...executor, route: 'reviewer' as const }
    : await probeRouteCapabilities('reviewer', config.reviewer, options);

  const warnings = [...executor.warnings, ...reviewer.warnings];
  const routeFailed = (r: RoutePreflightResult) =>
    r.credentialStatus === 'missing' || r.credentialStatus === 'rejected' || r.credentialStatus === 'unreachable'
    || r.modelListed === false || (r.route === 'executor' && r.supportsTools === false);

  return {
    readOnly: true,
    checkedAt: new Date().toISOString(),
    passed: !routeFailed(executor) && !routeFailed(reviewer),
    executor,
    reviewer,
    warnings,
  };
}
