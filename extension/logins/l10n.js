"use strict";

/* A small Fluent implementation standing in for Firefox's document.l10n on
 * the passwords page. It reads Firefox's own about:logins strings (and
 * passfox's overrides) and supports what they use: terms, variables,
 * plural/string selectors, NUMBER, DATETIME, PLATFORM, attributes, and
 * data-l10n-name markup overlays. */
(() => {
  const FILES = [
    "/vendor/firefox/l10n/brand.ftl",
    "/vendor/firefox/l10n/brandings.ftl",
    "/vendor/firefox/l10n/aboutLogins.ftl",
    "/logins/passfox.ftl",
  ];
  const LOCALE = "en-US";
  const messages = new Map();
  const plural = new Intl.PluralRules(LOCALE);

  /* ::::: parsing ::::: */

  function parseFile(text) {
    let entry = null;
    for (const line of text.split("\n")) {
      if (/^#/.test(line) || (!line.trim() && !entry)) {
        entry = /^#/.test(line) ? null : entry;
        continue;
      }
      const head = line.match(/^(-?[a-zA-Z][\w-]*)\s*=\s?(.*)$/);
      if (head) {
        entry = { id: head[1], value: [head[2]], attributes: new Map(), current: null };
        entry.current = entry.value;
        messages.set(entry.id, entry);
        continue;
      }
      if (!entry) {
        continue;
      }
      const attr = line.match(/^\s+\.([\w-]+)\s*=\s?(.*)$/);
      if (attr) {
        entry.current = [attr[2]];
        entry.attributes.set(attr[1], entry.current);
      } else {
        entry.current.push(line);
      }
    }
    for (const [, e] of messages) {
      if (!e.compiled) {
        e.value = compile(e.value);
        e.attributes = new Map([...e.attributes].map(([k, v]) => [k, compile(v)]));
        e.compiled = true;
      }
    }
  }

  // Joins a value's lines (dropping their indentation) and parses it.
  function compile(lines) {
    const text = lines
      .map((l, i) => (i ? l.replace(/^\s+/, "") : l))
      .join("\n")
      .replace(/^\s+|\s+$/g, "");
    if (!text) {
      return null;
    }
    const parser = { src: text, i: 0 };
    return parsePattern(parser, false);
  }

  function parsePattern(p, inVariant) {
    const parts = [];
    let text = "";
    while (p.i < p.src.length) {
      const c = p.src[p.i];
      if (c == "{") {
        if (text) {
          parts.push(text);
          text = "";
        }
        p.i++;
        parts.push(parsePlaceable(p));
        continue;
      }
      if (inVariant && c == "\n") {
        const rest = p.src.slice(p.i + 1).replace(/^\s+/, "");
        if (/^(\*?\[|\})/.test(rest)) {
          break;
        }
      }
      if (inVariant && c == "}") {
        break;
      }
      text += c;
      p.i++;
    }
    if (text) {
      parts.push(text);
    }
    return parts;
  }

  function skipSpace(p) {
    while (/\s/.test(p.src[p.i] ?? "")) {
      p.i++;
    }
  }

  function parseExpression(p) {
    skipSpace(p);
    const rest = p.src.slice(p.i);
    let m;
    if ((m = rest.match(/^"((?:[^"\\]|\\.)*)"/))) {
      p.i += m[0].length;
      return { type: "literal", value: m[1].replace(/\\(.)/g, "$1") };
    }
    if ((m = rest.match(/^-?\d+(\.\d+)?/))) {
      p.i += m[0].length;
      return { type: "literal", value: Number(m[0]) };
    }
    if ((m = rest.match(/^\$([\w-]+)/))) {
      p.i += m[0].length;
      return { type: "var", name: m[1] };
    }
    if ((m = rest.match(/^(-?[a-zA-Z][\w-]*)(\.[\w-]+)?/))) {
      p.i += m[0].length;
      const node = { type: m[1].startsWith("-") ? "term" : /^[A-Z][A-Z0-9_]*$/.test(m[1]) ? "fn" : "message", name: m[1], attr: m[2]?.slice(1), args: [], opts: {} };
      skipSpace(p);
      if (p.src[p.i] == "(") {
        p.i++;
        for (;;) {
          skipSpace(p);
          if (p.src[p.i] == ")") {
            p.i++;
            break;
          }
          const named = p.src.slice(p.i).match(/^([\w-]+)\s*:\s*/);
          if (named) {
            p.i += named[0].length;
            node.opts[named[1]] = parseExpression(p).value;
          } else {
            node.args.push(parseExpression(p));
          }
          skipSpace(p);
          if (p.src[p.i] == ",") {
            p.i++;
          }
        }
      }
      return node;
    }
    throw new Error(`Fluent: can't parse "${rest.slice(0, 30)}"`);
  }

  function parsePlaceable(p) {
    const expr = parseExpression(p);
    skipSpace(p);
    if (p.src.startsWith("->", p.i)) {
      p.i += 2;
      const variants = [];
      for (;;) {
        skipSpace(p);
        if (p.src[p.i] == "}") {
          p.i++;
          break;
        }
        const isDefault = p.src[p.i] == "*";
        if (isDefault) {
          p.i++;
        }
        const key = p.src.slice(p.i).match(/^\[\s*([^\]]+?)\s*\]/);
        p.i += key[0].length;
        variants.push({ key: key[1], isDefault, value: parsePattern(p, true) });
      }
      return { type: "select", selector: expr, variants };
    }
    if (p.src[p.i] == "}") {
      p.i++;
    }
    return expr;
  }

  /* ::::: formatting ::::: */

  function resolve(node, args) {
    switch (node.type) {
      case "literal":
        return node.value;
      case "var":
        return args?.[node.name] ?? `{$${node.name}}`;
      case "term":
      case "message": {
        const entry = messages.get(node.name);
        if (!entry) {
          return `{${node.name}}`;
        }
        const pattern = node.attr ? entry.attributes.get(node.attr) : entry.value;
        return format(pattern, node.type == "term" ? node.opts : args);
      }
      case "fn":
        return callFunction(node, args);
      case "select": {
        const value = resolve(node.selector, args);
        const variant =
          node.variants.find(v => String(v.key) == String(value)) ??
          (typeof value == "number" ? node.variants.find(v => v.key == plural.select(value)) : undefined) ??
          node.variants.find(v => v.isDefault);
        return format(variant.value, args);
      }
    }
    return "";
  }

  function callFunction(node, args) {
    const value = node.args.length ? resolve(node.args[0], args) : null;
    switch (node.name) {
      case "NUMBER":
        return typeof value == "number" ? new Intl.NumberFormat(LOCALE, node.opts).format(value) : value;
      case "DATETIME":
        return new Intl.DateTimeFormat(LOCALE, node.opts).format(new Date(value));
      case "PLATFORM":
        return "linux";
    }
    return value;
  }

  function format(pattern, args) {
    if (!pattern) {
      return null;
    }
    return pattern.map(part => (typeof part == "string" ? part : resolve(part, args))).join("");
  }

  function formatMessage(id, args) {
    const entry = messages.get(id);
    if (!entry) {
      console.warn("passfox l10n: missing string", id);
      return null;
    }
    return {
      value: format(entry.value, args),
      attributes: [...entry.attributes].map(([name, pattern]) => ({ name, value: format(pattern, args) })),
    };
  }

  /* ::::: DOM ::::: */

  const TEXT_ELEMENTS = new Set(["em", "strong", "b", "i", "span", "small", "sup", "sub", "br"]);

  // Fluent's DOM overlay: markup in a translation may only reuse elements
  // the source marks with data-l10n-name, plus harmless text-level tags.
  function applyValue(element, value) {
    if (!/[<&]/.test(value)) {
      element.textContent = value;
      return;
    }
    const sources = new Map(
      [...element.querySelectorAll("[data-l10n-name]")].map(e => [e.dataset.l10nName, e])
    );
    // An inert document: nothing in it loads or runs.
    const parsed = new DOMParser().parseFromString(`<body>${value}`, "text/html").body;
    const build = node => {
      if (node.nodeType == Node.TEXT_NODE) {
        return document.createTextNode(node.textContent);
      }
      if (node.nodeType != Node.ELEMENT_NODE) {
        return null;
      }
      const source = sources.get(node.getAttribute("data-l10n-name"));
      const out = source
        ? source.cloneNode(false)
        : TEXT_ELEMENTS.has(node.localName)
          ? document.createElement(node.localName)
          : null;
      if (!out) {
        return document.createTextNode(node.textContent);
      }
      out.append(...[...node.childNodes].map(build).filter(Boolean));
      return out;
    };
    element.replaceChildren(...[...parsed.childNodes].map(build).filter(Boolean));
  }

  function argsOf(element) {
    try {
      return JSON.parse(element.getAttribute("data-l10n-args") || "{}");
    } catch {
      return {};
    }
  }

  function translateElement(element) {
    const id = element.getAttribute("data-l10n-id");
    const message = id && formatMessage(id, argsOf(element));
    if (!message) {
      return;
    }
    if (message.value != null) {
      applyValue(element, message.value);
    }
    for (const { name, value } of message.attributes) {
      element.setAttribute(name, value);
    }
  }

  function translateTree(root) {
    if (root.nodeType == Node.ELEMENT_NODE && root.hasAttribute("data-l10n-id")) {
      translateElement(root);
    }
    root.querySelectorAll?.("[data-l10n-id]").forEach(translateElement);
  }

  const loaded = Promise.all(
    FILES.map(f => fetch(f).then(r => (r.ok ? r.text() : "")))
  ).then(texts => texts.forEach(parseFile));

  const observers = new Map();
  function connect(root) {
    if (observers.has(root)) {
      return;
    }
    const observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.type == "attributes") {
          translateElement(record.target);
        } else {
          record.addedNodes.forEach(translateTree);
        }
      }
    });
    observers.set(root, observer);
    loaded.then(() => {
      translateTree(root);
      observer.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["data-l10n-id", "data-l10n-args"],
      });
    });
  }

  document.l10n = {
    ready: loaded,
    connectRoot: connect,
    disconnectRoot(root) {
      observers.get(root)?.disconnect();
      observers.delete(root);
    },
    async translateElements(elements) {
      await loaded;
      elements.forEach(translateElement);
    },
    async translateFragment(fragment) {
      await loaded;
      translateTree(fragment);
    },
    setAttributes(element, id, args) {
      element.setAttribute("data-l10n-id", id);
      if (args) {
        element.setAttribute("data-l10n-args", JSON.stringify(args));
      } else {
        element.removeAttribute("data-l10n-args");
      }
      if (!element.isConnected || !observers.size) {
        loaded.then(() => translateElement(element));
      }
    },
    getAttributes(element) {
      return { id: element.getAttribute("data-l10n-id"), args: argsOf(element) };
    },
    async formatMessages(keys) {
      await loaded;
      return keys.map(({ id, args }) => formatMessage(id, args));
    },
    async formatValue(id, args) {
      await loaded;
      return formatMessage(id, args)?.value;
    },
    async formatValues(keys) {
      await loaded;
      return keys.map(({ id, args }) => formatMessage(id, args)?.value);
    },
  };

  connect(document.documentElement);
})();
