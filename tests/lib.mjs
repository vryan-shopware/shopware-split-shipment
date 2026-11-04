// Small helpers for the plugin's Store API / Admin API scripts (no dependencies).

export function arg(name, fallback = undefined) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((value) => value.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function base(url) {
  return url.replace(/\/(admin|api|store-api)\/?$/, "").replace(/\/$/, "");
}

export async function adminClient(provisioning) {
  const root = base(provisioning.admin.apiBaseUrl || provisioning.admin.url);
  const tokenResponse = await fetch(`${root}/api/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "password", client_id: "administration", scope: "write", username: provisioning.admin.username, password: provisioning.admin.password })
  });
  const { access_token: token } = await tokenResponse.json();

  async function call(method, path, body) {
    const response = await fetch(`${root}/api/${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path} ${response.status}: ${text.slice(0, 400)}`);
    return text ? JSON.parse(text) : null;
  }

  const plain = (entity) => (entity && entity.attributes ? { id: entity.id, ...entity.attributes } : entity);

  return {
    async search(entity, criteria) {
      const result = await call("POST", `search/${entity}`, criteria);
      return { ...result, data: (result.data || []).map(plain) };
    },
    post: (path, body) => call("POST", path, body),
    patch: (path, body) => call("PATCH", path, body),
    get: (path) => call("GET", path),
    async setConfig(values) {
      await call("POST", "_action/system-config", values);
    }
  };
}

export function storeClient(provisioning) {
  const root = base(provisioning.storefront.storeApiBaseUrl || provisioning.env.SHOPWARE_STORE_API_URL);
  const accessKey = provisioning.env?.SHOPWARE_STORE_API_ACCESS_KEY || provisioning.storefront?.accessKey;
  let contextToken = null;

  async function call(method, path, body) {
    const response = await fetch(`${root}/store-api/${path}`, {
      method,
      headers: {
        "sw-access-key": accessKey,
        "content-type": "application/json",
        accept: "application/json",
        ...(contextToken ? { "sw-context-token": contextToken } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    contextToken = response.headers.get("sw-context-token") || contextToken;
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`${method} ${path} ${response.status}: not JSON: ${text.slice(0, 200)}`);
    }
    if (!response.ok) {
      const error = new Error(`${method} ${path} ${response.status}: ${text.slice(0, 500)}`);
      error.status = response.status;
      error.body = json;
      throw error;
    }
    return json;
  }

  return {
    login: (username, password) => call("POST", "account/login", { username, password }),
    get: (path) => call("GET", path),
    post: (path, body) => call("POST", path, body),
    delete: (path) => call("DELETE", path)
  };
}
