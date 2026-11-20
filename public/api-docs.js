(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const state = {
    spec: null,
    query: "",
    tag: "",
    allOpen: false
  };

  const METHOD_ORDER = ["get", "post", "patch", "put", "delete"];
  const LOCATION_LABELS = {
    path: "路径",
    query: "查询",
    header: "请求头",
    cookie: "Cookie"
  };

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function deref(schema) {
    let current = schema || {};
    for (let guard = 0; guard < 30; guard += 1) {
      if (!current || !current.$ref) return current || {};
      const name = current.$ref.split("/").pop();
      current = state.spec?.components?.schemas?.[name] || {};
    }
    return {};
  }

  function mergedSchema(schema) {
    const base = deref(schema);
    if (!base.allOf) return base;
    const merged = { ...base };
    delete merged.allOf;
    for (const part of base.allOf) {
      const nested = mergedSchema(part);
      merged.properties = {
        ...(nested.properties || {}),
        ...(merged.properties || {})
      };
      merged.required = [
        ...new Set([
          ...(nested.required || []),
          ...(merged.required || [])
        ])
      ];
      if (!merged.type && nested.type) merged.type = nested.type;
      if (!merged.additionalProperties && nested.additionalProperties) {
        merged.additionalProperties = nested.additionalProperties;
      }
    }
    return merged;
  }

  function typeName(schema) {
    const value = deref(schema);
    if (value.anyOf) {
      return value.anyOf.map(typeName).join(" | ");
    }
    if (value.oneOf) {
      return value.oneOf.map(typeName).join(" | ");
    }
    if (value.allOf) {
      return typeName(mergedSchema(value));
    }
    if (Array.isArray(value.type)) {
      return value.type.join(" | ");
    }
    if (value.enum) {
      return value.enum.map((item) => JSON.stringify(item)).join(" | ");
    }
    if (value.type === "array") {
      return `${typeName(value.items)}[]`;
    }
    if (value.type === "string" && value.format) {
      return `string (${value.format})`;
    }
    if (value.properties && !value.type) return "object";
    return value.type || "any";
  }

  function schemaExample(schema, depth = 0) {
    if (depth > 5) return null;
    const value = mergedSchema(schema);
    if (value.example !== undefined) return value.example;
    if (value.default !== undefined) return value.default;
    if (value.enum) return value.enum[0];
    if (value.anyOf) {
      const first = value.anyOf.find((item) => deref(item).type !== "null");
      return schemaExample(first || value.anyOf[0], depth + 1);
    }
    if (value.oneOf) return schemaExample(value.oneOf[0], depth + 1);
    if (value.type === "array" || value.items) {
      return [schemaExample(value.items || {}, depth + 1)];
    }
    if (value.type === "object" || value.properties) {
      const object = {};
      for (const [key, child] of Object.entries(value.properties || {})) {
        object[key] = schemaExample(child, depth + 1);
      }
      return object;
    }
    switch (value.type) {
      case "boolean":
        return true;
      case "integer":
      case "number":
        return 1;
      case "string":
        if (value.format === "date-time") return "2026-11-17T08:00:00.000Z";
        if (value.format === "date") return "2026-11-17";
        return "string";
      default:
        return null;
    }
  }

  function jsonExample(media, schema) {
    if (media && media.example !== undefined) return media.example;
    return schemaExample(schema);
  }

  function mediaInfo(content) {
    if (!content) return null;
    const types = Object.keys(content);
    if (!types.length) return null;
    const jsonType = types.find((type) => type.includes("json"));
    const type = jsonType || types[0];
    return { type, media: content[type], types };
  }

  function pretty(value) {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  function operationEntries(spec) {
    const entries = [];
    for (const [path, item] of Object.entries(spec.paths || {})) {
      const methods = Object.keys(item).filter((method) =>
        METHOD_ORDER.includes(method)
      );
      methods.sort(
        (a, b) => METHOD_ORDER.indexOf(a) - METHOD_ORDER.indexOf(b)
      );
      for (const method of methods) {
        entries.push({ path, method, operation: item[method] });
      }
    }
    return entries;
  }

  function tagFor(operation, knownTags) {
    const tag = Array.isArray(operation.tags) && operation.tags.length
      ? operation.tags[0]
      : "其他";
    return knownTags.some((item) => item.name === tag) ? tag : "其他";
  }

  function parameterRows(operation) {
    return Array.isArray(operation.parameters) ? operation.parameters : [];
  }

  function renderParameterTable(parameters) {
    if (!parameters.length) return "";
    const rows = parameters
      .map((parameter) => {
        const schema = deref(parameter.schema);
        const defaultValue =
          schema.default !== undefined
            ? `<br /><span class="req-no">默认：${escapeHtml(
                JSON.stringify(schema.default)
              )}</span>`
            : "";
        return `<tr>
          <td><code>${escapeHtml(parameter.name)}</code></td>
          <td>${escapeHtml(
            LOCATION_LABELS[parameter.in] || parameter.in
          )}</td>
          <td>${
            parameter.required
              ? '<span class="req-yes">必填</span>'
              : '<span class="req-no">可选</span>'
          }</td>
          <td><code>${escapeHtml(typeName(schema))}</code>${defaultValue}</td>
          <td>${escapeHtml(parameter.description || "")}</td>
        </tr>`;
      })
      .join("");
    return `<table class="param-table">
      <thead>
        <tr><th>名称</th><th>位置</th><th>必填</th><th>类型</th><th>说明</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  function renderSchemaTable(schema) {
    const value = mergedSchema(schema);
    const properties = value.properties || {};
    const required = new Set(value.required || []);
    const keys = Object.keys(properties);
    if (!keys.length) {
      return `<p class="req-no">无字段定义（${escapeHtml(
        typeName(value)
      )}）。</p>`;
    }
    const rows = keys
      .map((key) => {
        const child = mergedSchema(properties[key]);
        const constraints = [];
        if (child.minLength !== undefined) {
          constraints.push(`minLength ${child.minLength}`);
        }
        if (child.maxLength !== undefined) {
          constraints.push(`maxLength ${child.maxLength}`);
        }
        if (child.minimum !== undefined) {
          constraints.push(`minimum ${child.minimum}`);
        }
        if (child.maximum !== undefined) {
          constraints.push(`maximum ${child.maximum}`);
        }
        if (child.minItems !== undefined) {
          constraints.push(`minItems ${child.minItems}`);
        }
        if (child.maxItems !== undefined) {
          constraints.push(`maxItems ${child.maxItems}`);
        }
        const extra = constraints.length
          ? `<br /><span class="req-no">${escapeHtml(
              constraints.join(" · ")
            )}</span>`
          : "";
        return `<tr>
          <td><code>${escapeHtml(key)}</code></td>
          <td>${
            required.has(key)
              ? '<span class="req-yes">必填</span>'
              : '<span class="req-no">可选</span>'
          }</td>
          <td><code>${escapeHtml(typeName(child))}</code>${extra}</td>
          <td>${escapeHtml(child.description || "")}</td>
        </tr>`;
      })
      .join("");
    return `<table class="schema-table">
      <thead>
        <tr><th>字段</th><th>必填</th><th>类型</th><th>说明</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  function renderRequestBody(operation) {
    const body = operation.requestBody;
    if (!body) return "";
    const info = mediaInfo(body.content);
    if (!info) {
      return `<h3 class="subhead">请求体</h3><p class="req-no">${escapeHtml(
        body.description || "无请求体定义"
      )}</p>`;
    }
    const schema = info.media?.schema || {};
    const isJson = info.type.includes("json");
    const example = isJson ? jsonExample(info.media, schema) : null;
    const typePills = info.types
      .map((type) => `<span class="pill">${escapeHtml(type)}</span>`)
      .join(" ");
    return `<h3 class="subhead">请求体</h3>
      <p class="req-no">${escapeHtml(body.description || "")}</p>
      <p>${typePills}${
        body.required ? ' <span class="req-yes">必填</span>' : ""
      }</p>
      ${
        isJson
          ? `${renderSchemaTable(schema)}
             <div class="pre-wrap"><pre>${escapeHtml(
               pretty(example)
             )}</pre></div>`
          : `<div class="pre-wrap"><pre>${escapeHtml(
              info.type === "application/octet-stream" ||
                info.type.startsWith("image/")
                ? "二进制请求体：请使用文件上传或 curl --data-binary"
                : "该请求体为二进制或表单数据，请使用 HTTP 客户端发送。"
            )}</pre></div>`
      }`;
  }

  function renderResponses(operation) {
    const responses = operation.responses || {};
    const blocks = Object.entries(responses)
      .map(([status, response]) => {
        const info = mediaInfo(response.content);
        let content = "";
        if (info) {
          if (info.type.includes("json")) {
            const example = jsonExample(info.media, info.media?.schema);
            if (example !== undefined && example !== null) {
              content = `<div class="pre-wrap"><pre>${escapeHtml(
                pretty(example)
              )}</pre></div>`;
            } else {
              content = `<p class="req-no">类型：<code>${escapeHtml(
                typeName(info.media?.schema)
              )}</code></p>`;
            }
          } else {
            content = `<p class="req-no">内容类型：<code>${escapeHtml(
              info.type
            )}</code>（二进制响应）</p>`;
          }
        }
        return `<div class="response">
          <h4>
            <span class="status-code">${escapeHtml(status)}</span>
            <span class="response-desc">${escapeHtml(
              response.description || ""
            )}</span>
          </h4>
          ${content}
        </div>`;
      })
      .join("");
    return `<h3 class="subhead">响应</h3>${blocks}`;
  }

  function randomKey() {
    try {
      if (globalThis.crypto?.getRandomValues) {
        const bytes = new Uint8Array(8);
        crypto.getRandomValues(bytes);
        return `docs-${Array.from(bytes, (byte) =>
          byte.toString(16).padStart(2, "0")
        ).join("")}`;
      }
    } catch {
      // Older HTTP deployments may not expose Web Crypto.
    }
    return `docs-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 10)}`;
  }

  function defaultParameterValue(parameter) {
    const schema = deref(parameter.schema);
    if (parameter.name.toLowerCase() === "idempotency-key") {
      return randomKey();
    }
    if (schema.default !== undefined) return String(schema.default);
    if (schema.example !== undefined) return String(schema.example);
    return "";
  }

  function renderTryForm(path, method, operation) {
    const parameters = parameterRows(operation);
    const info = mediaInfo(operation.requestBody?.content);
    const fields = parameters
      .map((parameter) => {
        const value = defaultParameterValue(parameter);
        const type =
          parameter.in === "path" || parameter.name === "limit"
            ? "number"
            : "text";
        return `<div class="field">
          <label for="try-${escapeHtml(operation.operationId)}-${escapeHtml(
            parameter.in
          )}-${escapeHtml(parameter.name)}">
            ${escapeHtml(parameter.name)}
            <span class="req-no">（${escapeHtml(
              LOCATION_LABELS[parameter.in] || parameter.in
            )}${parameter.required ? " · 必填" : ""}）</span>
          </label>
          <input
            id="try-${escapeHtml(operation.operationId)}-${escapeHtml(
              parameter.in
            )}-${escapeHtml(parameter.name)}"
            data-param-name="${escapeHtml(parameter.name)}"
            data-param-in="${escapeHtml(parameter.in)}"
            data-param-required="${parameter.required ? "1" : "0"}"
            type="${type}"
            value="${escapeHtml(value)}"
            placeholder="${escapeHtml(
              parameter.in === "path" ? "例如 1" : ""
            )}"
          />
        </div>`;
      })
      .join("");

    let bodyField = "";
    if (info) {
      if (info.type.includes("json")) {
        const example = jsonExample(info.media, info.media?.schema);
        bodyField = `<div class="field field-wide">
          <label for="try-${escapeHtml(operation.operationId)}-body">
            请求体（JSON）
            ${operation.requestBody.required ? '<span class="req-yes">必填</span>' : ""}
          </label>
          <textarea
            id="try-${escapeHtml(operation.operationId)}-body"
            data-body-kind="json"
            spellcheck="false"
          >${escapeHtml(pretty(example))}</textarea>
        </div>`;
      } else {
        bodyField = `<div class="field field-wide">
          <label for="try-${escapeHtml(operation.operationId)}-file">
            请求体（图片 / 二进制）
            ${operation.requestBody.required ? '<span class="req-yes">必填</span>' : ""}
          </label>
          <input
            id="try-${escapeHtml(operation.operationId)}-file"
            data-body-kind="file"
            type="file"
            accept="image/jpeg,image/png,image/webp,application/octet-stream"
          />
        </div>`;
      }
    }

    return `<div class="try">
      <h3>Try it out</h3>
      <p class="try-note">请求会直接发往当前服务。写接口会真实修改本地数据；危险接口会再次确认。</p>
      <div class="try-form">${fields}${bodyField}</div>
      <div class="try-actions">
        <button class="btn primary" type="button" data-action="send">发送请求</button>
        <button class="btn" type="button" data-action="curl">复制 cURL</button>
      </div>
      <div class="try-result" hidden aria-live="polite"></div>
    </div>`;
  }

  function renderOperation(path, method, operation, tag) {
    const section = document.createElement("section");
    section.className = "op";
    section.id = `op-${operation.operationId}`;
    section.dataset.search = [
      path,
      method,
      operation.summary,
      operation.description,
      operation.operationId,
      tag
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    section.dataset.tag = tag;

    const parameters = parameterRows(operation);
    const details = document.createElement("details");
    details.className = "op-details";
    const summary = document.createElement("summary");
    summary.innerHTML = `<span class="method method-${escapeHtml(
      method
    )}">${escapeHtml(method.toUpperCase())}</span>
      <code class="op-path">${escapeHtml(path)}</code>
      <span class="op-summary">${escapeHtml(
        operation.summary || operation.description || ""
      )}</span>`;
    details.appendChild(summary);

    const body = document.createElement("div");
    body.className = "op-body";
    body.innerHTML = `
      <p class="op-description">${escapeHtml(
        operation.description || operation.summary || ""
      )}</p>
      <div class="op-meta">
        <span class="pill">${escapeHtml(operation.operationId || "")}</span>
        <span class="pill">${escapeHtml(tag)}</span>
        ${
          operation["x-dangerous"]
            ? '<span class="pill pill-danger">危险操作</span>'
            : ""
        }
      </div>
      ${
        parameters.length
          ? `<h3 class="subhead">参数</h3>${renderParameterTable(parameters)}`
          : ""
      }
      ${renderRequestBody(operation)}
      ${renderResponses(operation)}
      ${renderTryForm(path, method, operation)}
    `;
    details.appendChild(body);
    section.appendChild(details);

    bindTryForm(section, path, method, operation);
    return section;
  }

  function buildBaseUrl() {
    const configured = state.spec?.servers?.[0]?.url || "/";
    try {
      return new URL(configured, location.origin).href.replace(/\/$/, "");
    } catch {
      return location.origin;
    }
  }

  function shellQuote(value) {
    return `'${String(value).replaceAll("'", `'\\''`)}'`;
  }

  function collectParameterValues(form) {
    const values = new Map();
    for (const input of form.querySelectorAll("[data-param-name]")) {
      const key = `${input.dataset.paramIn}:${input.dataset.paramName}`;
      values.set(key, input.value.trim());
    }
    return values;
  }

  function applyPathParameters(path, values) {
    return path.replace(/\{([^}]+)\}/g, (match, name) => {
      const value = values.get(`path:${name}`);
      if (!value) {
        throw new Error(`请填写路径参数 ${name}`);
      }
      return encodeURIComponent(value);
    });
  }

  function buildRequestUrl(path, values) {
    const url = new URL(
      applyPathParameters(path, values),
      `${buildBaseUrl()}/`
    );
    const query = new URLSearchParams();
    for (const [key, value] of values) {
      const [location_, name] = key.split(/:(.*)/s);
      if (location_ === "query" && value) query.append(name, value);
    }
    url.search = query.toString();
    return url.toString();
  }

  function requestHeaders(operation, values, bodyInfo) {
    const headers = {};
    for (const parameter of parameterRows(operation)) {
      if (parameter.in !== "header") continue;
      const name = parameter.name;
      if (name.toLowerCase() === "content-type") continue;
      const value = values.get(`header:${name}`);
      if (value) headers[name] = value;
    }
    if (bodyInfo?.contentType) headers["Content-Type"] = bodyInfo.contentType;
    return headers;
  }

  function readRequestBody(section) {
    const jsonField = section.querySelector('[data-body-kind="json"]');
    if (jsonField) {
      const text = jsonField.value.trim();
      if (!text) return { body: undefined };
      try {
        return {
          body: JSON.stringify(JSON.parse(text)),
          contentType: "application/json"
        };
      } catch (error) {
        throw new Error(`请求体不是有效 JSON：${error.message}`);
      }
    }
    const fileField = section.querySelector('[data-body-kind="file"]');
    if (fileField?.files?.length) {
      const file = fileField.files[0];
      return {
        body: file,
        contentType: file.type || "application/octet-stream",
        fileName: file.name
      };
    }
    return { body: undefined };
  }

  function validateRequiredParameters(operation, values) {
    for (const parameter of parameterRows(operation)) {
      if (!parameter.required) continue;
      if (parameter.in === "header" && parameter.name.toLowerCase() === "content-type") {
        continue;
      }
      if (!values.get(`${parameter.in}:${parameter.name}`)) {
        throw new Error(`请填写${LOCATION_LABELS[parameter.in] || parameter.in}参数 ${parameter.name}`);
      }
    }
  }

  function buildCurl(section, path, method, operation) {
    const values = collectParameterValues(section.querySelector(".try-form"));
    let url = `${buildBaseUrl()}${applyPathParameters(path, values)}`;
    const query = new URLSearchParams();
    for (const [key, value] of values) {
      const [location_, name] = key.split(/:(.*)/s);
      if (location_ === "query" && value) query.append(name, value);
    }
    if ([...query].length) url += `?${query.toString()}`;

    const headerLines = [];
    for (const parameter of parameterRows(operation)) {
      if (parameter.in !== "header") continue;
      if (parameter.name.toLowerCase() === "content-type") continue;
      const value = values.get(`header:${parameter.name}`);
      if (value) headerLines.push(`-H ${shellQuote(`${parameter.name}: ${value}`)}`);
    }

    const parts = [`curl -X ${method.toUpperCase()} ${shellQuote(url)}`];
    let bodyArgs = [];
    const jsonField = section.querySelector('[data-body-kind="json"]');
    if (jsonField?.value.trim()) {
      headerLines.push(`-H 'Content-Type: application/json'`);
      bodyArgs = [`--data-binary ${shellQuote(jsonField.value.trim())}`];
    }
    const fileField = section.querySelector('[data-body-kind="file"]');
    if (fileField?.files?.length) {
      const file = fileField.files[0];
      headerLines.push(
        `-H ${shellQuote(`Content-Type: ${file.type || "application/octet-stream"}`)}`
      );
      bodyArgs = [`--data-binary ${shellQuote(`@${file.name}`)}`];
    }
    parts.push(...headerLines);
    parts.push(...bodyArgs);
    const command = parts.join(" \\\n  ");
    copyText(command);
  }

  function responseHeaders(response) {
    const wanted = [
      "content-type",
      "content-length",
      "cache-control",
      "etag",
      "x-content-type-options"
    ];
    const lines = [];
    for (const name of wanted) {
      const value = response.headers.get(name);
      if (value) lines.push(`${name}: ${value}`);
    }
    return lines.join("\n");
  }

  function renderResponseResult(resultBox, response, startedAt, payload) {
    const elapsed = Math.round(performance.now() - startedAt);
    const statusClass = response.ok ? "result-ok" : "result-bad";
    const headerText = responseHeaders(response);
    const contentType = response.headers.get("content-type") || "";

    resultBox.hidden = false;
    if (contentType.startsWith("image/")) {
      const url = URL.createObjectURL(payload.blob);
      resultBox.innerHTML = `
        <div class="result-head">
          <span class="result-status ${statusClass}">${response.status} ${escapeHtml(
            response.statusText
          )}</span>
          <span class="result-meta">${elapsed} ms · ${escapeHtml(contentType)} · ${payload.size} bytes</span>
        </div>
        <img class="result-image" alt="接口返回的图片" src="${url}" />
        <p><a href="${url}" download="attachment-${Date.now()}">下载图片</a></p>
        <pre class="result-pre">${escapeHtml(headerText)}</pre>`;
      return;
    }
    if (contentType.includes("octet-stream")) {
      const url = URL.createObjectURL(payload.blob);
      resultBox.innerHTML = `
        <div class="result-head">
          <span class="result-status ${statusClass}">${response.status} ${escapeHtml(
            response.statusText
          )}</span>
          <span class="result-meta">${elapsed} ms · ${escapeHtml(contentType)} · ${payload.size} bytes</span>
        </div>
        <p><a href="${url}" download="response.bin">下载二进制响应（${payload.size} bytes）</a></p>
        <pre class="result-pre">${escapeHtml(headerText)}</pre>`;
      return;
    }
    resultBox.innerHTML = `
      <div class="result-head">
        <span class="result-status ${statusClass}">${response.status} ${escapeHtml(
          response.statusText
        )}</span>
        <span class="result-meta">${elapsed} ms · ${payload.size} bytes</span>
      </div>
      ${
        headerText
          ? `<pre class="result-pre">${escapeHtml(headerText)}</pre>`
          : ""
      }
      <pre class="result-pre">${escapeHtml(payload.text)}</pre>`;
  }

  async function sendTryRequest(section, path, method, operation) {
    const resultBox = section.querySelector(".try-result");
    const form = section.querySelector(".try-form");
    const button = section.querySelector('[data-action="send"]');
    button.disabled = true;
    try {
      const values = collectParameterValues(form);
      validateRequiredParameters(operation, values);
      if (
        method === "delete" &&
        path.includes("/api/learning-data") &&
        !window.confirm("这会不可逆地删除全部学习数据。确定继续吗？")
      ) {
        return;
      }
      const bodyInfo = readRequestBody(section);
      if (operation.requestBody?.required && !bodyInfo.body) {
        throw new Error("该接口需要请求体");
      }
      const url = buildRequestUrl(path, values);
      const headers = requestHeaders(operation, values, bodyInfo);
      const startedAt = performance.now();
      const response = await fetch(url, {
        method: method.toUpperCase(),
        headers,
        body: bodyInfo.body,
        cache: "no-store"
      });
      const payload = await response.arrayBuffer();
      const buffer = new Uint8Array(payload);
      let text = "";
      try {
        text = new TextDecoder("utf-8").decode(buffer);
      } catch {
        text = "";
      }
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("json") && text) {
        try {
          text = pretty(JSON.parse(text));
        } catch {
          // Keep the original response text if it is not valid JSON.
        }
      }
      renderResponseResult(
        resultBox,
        response,
        startedAt,
        {
          size: buffer.byteLength,
          text,
          blob: new Blob([buffer], { type: contentType })
        }
      );
    } catch (error) {
      resultBox.hidden = false;
      resultBox.innerHTML = `
        <div class="result-head">
          <span class="result-status result-bad">请求失败</span>
        </div>
        <pre class="result-pre">${escapeHtml(error.message)}</pre>
        <p class="req-no">若浏览器控制台提示 CORS 或网络错误，请确认同源访问或经网关代理。</p>`;
    } finally {
      button.disabled = false;
    }
  }

  function bindTryForm(section, path, method, operation) {
    const send = section.querySelector('[data-action="send"]');
    const curl = section.querySelector('[data-action="curl"]');
    send?.addEventListener("click", () =>
      sendTryRequest(section, path, method, operation)
    );
    curl?.addEventListener("click", () =>
      buildCurl(section, path, method, operation)
    );
  }

  function toast(message) {
    const box = $("toast");
    box.textContent = message;
    box.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => {
      box.hidden = true;
    }, 2200);
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        toast("已复制");
        return;
      }
    } catch {
      // HTTP (non-secure context) may not expose the Clipboard API.
    }
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "readonly");
    area.className = "copy-buffer";
    document.body.appendChild(area);
    area.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    area.remove();
    toast(copied ? "已复制" : "复制失败，请手动选择文本");
  }

  function buildTagNav(tagDefinitions, entries) {
    const nav = $("tag-nav");
    nav.innerHTML = "";
    const allButton = document.createElement("button");
    allButton.type = "button";
    allButton.textContent = `全部 · ${entries.length}`;
    allButton.dataset.tag = "";
    allButton.setAttribute("aria-pressed", "true");
    nav.appendChild(allButton);

    for (const definition of tagDefinitions) {
      const count = entries.filter(
        (entry) => tagFor(entry.operation, tagDefinitions) === definition.name
      ).length;
      if (!count) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `${definition.name} · ${count}`;
      button.dataset.tag = definition.name;
      button.setAttribute("aria-pressed", "false");
      nav.appendChild(button);
    }

    nav.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-tag]");
      if (!button) return;
      state.tag = button.dataset.tag || "";
      for (const item of nav.querySelectorAll("button[data-tag]")) {
        item.setAttribute(
          "aria-pressed",
          item === button ? "true" : "false"
        );
      }
      applyFilters();
    });
  }

  function applyFilters() {
    const query = state.query.trim().toLowerCase();
    let visible = 0;
    for (const section of document.querySelectorAll(".op")) {
      const matchesTag = !state.tag || section.dataset.tag === state.tag;
      const matchesQuery =
        !query || section.dataset.search.includes(query);
      const show = matchesTag && matchesQuery;
      section.hidden = !show;
      if (show) visible += 1;
    }
    for (const section of document.querySelectorAll("[data-tag-section]")) {
      const operations = [...section.querySelectorAll(".op")];
      section.hidden = !operations.some((item) => !item.hidden);
    }
    $("result-count").textContent = query || state.tag
      ? `显示 ${visible} 个接口`
      : `共 ${visible} 个接口`;
  }

  function renderTagSections(tagDefinitions, entries) {
    const container = $("operations");
    container.innerHTML = "";
    const knownTags = tagDefinitions.slice();
    const knownNames = new Set(knownTags.map((tag) => tag.name));
    if (entries.some((entry) => !knownNames.has(tagFor(entry.operation, knownTags)))) {
      knownTags.push({ name: "其他", description: "未分类接口。" });
    }

    for (const definition of knownTags) {
      const operations = entries.filter(
        (entry) => tagFor(entry.operation, knownTags) === definition.name
      );
      if (!operations.length) continue;
      const section = document.createElement("section");
      section.className = "tag-section";
      section.dataset.tagSection = definition.name;
      const header = document.createElement("div");
      header.className = "tag-title";
      header.innerHTML = `<h2>${escapeHtml(definition.name)}</h2>
        <p>${escapeHtml(definition.description || "")}</p>`;
      section.appendChild(header);
      for (const entry of operations) {
        section.appendChild(
          renderOperation(
            entry.path,
            entry.method,
            entry.operation,
            definition.name
          )
        );
      }
      container.appendChild(section);
    }
  }

  function setupTheme() {
    let saved = null;
    try {
      saved = localStorage.getItem("api-docs-theme");
    } catch {
      saved = null;
    }
    if (saved === "dark" || saved === "light") {
      document.documentElement.dataset.theme = saved;
    }
    $("theme-toggle").addEventListener("click", () => {
      const next =
        document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem("api-docs-theme", next);
      } catch {
        // Private mode can deny localStorage.
      }
    });
  }

  function render(spec) {
    state.spec = spec;
    document.title = `${spec.info?.title || "API 文档"} · API 文档`;
    const summary = spec.info?.summary || "";
    $("api-summary").textContent =
      summary || (spec.info?.description || "").split("\n")[0] || "";
    const baseUrl = buildBaseUrl();
    $("base-url").textContent = baseUrl;
    $("access-note").textContent =
      spec["x-authentication"] === "none"
        ? "当前 API 无内置账号体系或 API Key。默认只监听 127.0.0.1；对第三方开放时请经反向代理/网关加 TLS、鉴权和限流。浏览器跨域调用默认不被允许。"
        : "请按部署方说明配置鉴权后再接入。";

    const entries = operationEntries(spec);
    const tags = Array.isArray(spec.tags) ? spec.tags : [];
    buildTagNav(tags, entries);
    renderTagSections(tags, entries);
    $("loading").hidden = true;
    $("error").hidden = true;
    applyFilters();

    if (entries.some((entry) => entry.operation["x-dangerous"])) {
      // reserved for future explicit danger flags
    }

    const hash = location.hash.replace(/^#/, "");
    if (hash.startsWith("op-")) {
      const target = document.getElementById(hash);
      if (target) {
        target.querySelector("details")?.setAttribute("open", "open");
        target.scrollIntoView({ block: "start" });
      }
    }
  }

  async function init() {
    setupTheme();
    $("copy-base").addEventListener("click", () =>
      copyText($("base-url").textContent)
    );
    $("search").addEventListener("input", (event) => {
      state.query = event.target.value;
      applyFilters();
    });
    $("expand-all").addEventListener("click", () => {
      state.allOpen = !state.allOpen;
      for (const details of document.querySelectorAll(".op-details")) {
        details.open = state.allOpen;
      }
      $("expand-all").textContent = state.allOpen ? "全部收起" : "全部展开";
    });
    window.addEventListener("hashchange", () => {
      const hash = location.hash.replace(/^#/, "");
      if (!hash.startsWith("op-")) return;
      const target = document.getElementById(hash);
      target?.querySelector("details")?.setAttribute("open", "open");
      target?.scrollIntoView({ block: "start" });
    });

    try {
      const response = await fetch("/api/openapi.json", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      render(await response.json());
    } catch (error) {
      $("loading").hidden = true;
      $("error").hidden = false;
      $("error").textContent = `无法加载 OpenAPI 契约：${error.message}\n请确认服务已启动，并直接访问 /api/openapi.json 检查响应。`;
    }
  }

  init();
})();
