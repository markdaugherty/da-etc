/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */
import { DEF_HEADERS } from '../utils/constants.js';

const BASE_OPTS = {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
};

async function fetchTranslateConfig(org, site, authorization) {
  const opts = { headers: { Authorization: authorization } };

  const resp = await fetch(`https://admin.da.live/source/${org}/${site}/.da/translate.json`, opts);
  if (!resp.ok) {
    return {
      error: 'Error fetching translate config from DA.',
      status: resp.status,
    };
  }

  const json = await resp.json();
  return { json };
}

function rowsToMap(rows) {
  return rows.reduce((acc, row) => {
    acc[row.key] = row.value;
    return acc;
  }, {});
}

function extractEnvs(config) {
  const envs = {};
  Object.keys(config).forEach((key) => {
    if (!key.startsWith('translation.service.')) {
      return;
    }
    const [env, prop] = key.replace('translation.service.', '').split('.');
    if (env === 'name' || env === 'all' || env === 'key') {
      return;
    }
    envs[env] ??= {};
    envs[env][prop] = config[key];
  });
  return envs;
}

function formatConfig(json) {
  const config = rowsToMap(json.config.data);
  return {
    name: config['translation.service.name'],
    keyPath: config['translation.service.key.path'],
    envs: extractEnvs(config),
  };
}

function formatServiceKey(json) {
  return extractEnvs(rowsToMap(json.data));
}

async function fetchServiceKey(keyPath, authorization) {
  console.log('fetchServiceKey: fetching', keyPath);
  const resp = await fetch(keyPath, { headers: { Authorization: authorization } });
  console.log('fetchServiceKey: response status', resp.status, resp.statusText);
  if (!resp.ok) {
    const text = await resp.text().catch(() => '<unreadable body>');
    console.log('fetchServiceKey: error body', text);
    return {
      error: 'Error fetching service key from DA.',
      status: resp.status,
    };
  }
  const json = await resp.json();
  console.log('fetchServiceKey: json keys', Object.keys(json));
  return { json };
}

async function fetchTradosToken(service) {
  const body = JSON.stringify({
    client_id: service.clientId,
    client_secret: service.clientSecret,
    grant_type: 'client_credentials',
    audience: service.audience,
  });

  const opts = { ...BASE_OPTS, body };
  const resp = await fetch(service.authEndpoint, opts);
  if (!resp.ok) {
    return { error: 'Could not get token', status: resp.status };
  }
  const json = await resp.json();
  return { json, status: resp.status };
}

async function fetchLionbridgeToken(service) {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: service.clientId,
    client_secret: service.clientSecret,
  });

  const opts = {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  };
  const resp = await fetch(service.authEndpoint, opts);
  if (!resp.ok) {
    return { error: 'Could not get token', status: resp.status };
  }
  const json = await resp.json();
  return { json, status: resp.status };
}

const TOKEN_FETCHERS = {
  trados: fetchTradosToken,
  lionbridge: fetchLionbridgeToken,
};

function handleError({ error, status }) {
  return new Response(JSON.stringify(error), { status, headers: DEF_HEADERS });
}

async function fetchEnvCreds(org, site, authorization, serviceEnv) {
  const cfgResult = await fetchTranslateConfig(org, site, authorization);
  if (cfgResult.error) {
    return cfgResult;
  }

  const svcCfg = formatConfig(cfgResult.json);

  console.log('intRoute: svcCfg', { name: svcCfg.name, keyPath: svcCfg.keyPath, envs: Object.keys(svcCfg.envs) });

  let envCreds = svcCfg.envs[serviceEnv] ?? {};
  if (svcCfg.keyPath) {
    const keyResult = await fetchServiceKey(svcCfg.keyPath, authorization);
    if (keyResult.error) {
      return keyResult;
    }
    const keyEnvs = formatServiceKey(keyResult.json);
    envCreds = { ...envCreds, ...(keyEnvs[serviceEnv] ?? {}) };
  }

  console.log('intRoute: envCreds for', serviceEnv, envCreds ? Object.keys(envCreds) : '<none>');

  if (!envCreds?.clientSecret) {
    return { error: `Missing credentials for env '${serviceEnv}'.`, status: 400 };
  }

  return { json: envCreds };
}

export default async function intRoute({
  req, org, site, service, action,
}) {
  const authorization = req.headers.get('authorization');
  const { searchParams } = new URL(req.url);
  const serviceEnv = searchParams.get('env') ?? 'prod';

  if (!authorization) {
    return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
      status: 401,
      headers: DEF_HEADERS,
    });
  }

  const fetchToken = TOKEN_FETCHERS[service];

  if (fetchToken && action === 'login') {
    const credsResult = await fetchEnvCreds(org, site, authorization, serviceEnv);
    if (credsResult.error) {
      return handleError(credsResult);
    }

    const tokenResult = await fetchToken(credsResult.json);
    if (tokenResult.error) {
      return handleError(tokenResult);
    }
    console.log(tokenResult);
    return new Response(JSON.stringify(tokenResult.json), {
      status: tokenResult.status,
      headers: DEF_HEADERS,
    });
  }

  return handleError({ error: 'Route note supported.', status: 405 });
}
