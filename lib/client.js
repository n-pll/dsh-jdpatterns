// dsh-jdpatterns v3 — 设计模式参考库（client 半）
// 形态：window.__ModuleLoader__.load 自注册 bundle（ESM named export 浏览器不识别）。
// 陷阱防线：useState 一律直接解构（两段式重写会丢 value 行导致渲染崩溃被 slot 吞成空白页）。
window.__ModuleLoader__.load({
  id: "dsh-jdpatterns",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var React = require("react");
    var h = React.createElement;

    var STYLE_ID = "dsh-jdpatterns-settings-style";
    var API_BASE = "/api/jdpatterns";
    var BUILTIN_LANGS = ["java"];
    var LANG_RE = /^[a-z][a-z0-9-]*$/;
    // 与 host 半保持一致：各语言硬闸门受控扩展名（未列出的语言按 .<lang> 兜底）
    var GATE_EXT_BY_LANG = {
      java: [".java"], kotlin: [".kt"], scala: [".scala"],
      python: [".py"], javascript: [".js", ".jsx", ".mjs"], typescript: [".ts", ".tsx"],
      go: [".go"], rust: [".rs"], c: [".c"], cpp: [".cpp", ".cc"], csharp: [".cs"],
    };
    function gateExts(lang) { return GATE_EXT_BY_LANG[lang] || ["." + lang]; }

    function injectStyles() {
      try {
        if (document.getElementById(STYLE_ID)) return;
        var el = document.createElement("style");
        el.id = STYLE_ID;
        el.textContent = [
          ".jdp-root{display:flex;flex-direction:column;gap:16px;padding:4px 2px;color:var(--dsw-alias-text,inherit);font-size:13px;line-height:1.6}",
          ".jdp-card{border:1px solid var(--dsw-alias-border,rgba(128,128,128,.28));border-radius:8px;padding:12px 14px;background:var(--dsw-alias-surface,rgba(128,128,128,.06))}",
          ".jdp-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
          ".jdp-label{font-weight:600}",
          ".jdp-hint{color:var(--dsw-alias-muted,rgba(128,128,128,.9));font-size:12px}",
          ".jdp-field{display:flex;flex-direction:column;gap:4px;margin-top:10px}",
          ".jdp-field>span{font-size:12px;color:var(--dsw-alias-muted,rgba(128,128,128,.9))}",
          ".jdp-input{border:1px solid var(--dsw-alias-border,rgba(128,128,128,.28));border-radius:6px;padding:6px 8px;background:var(--dsw-alias-input,transparent);color:inherit;font-size:13px;width:100%;box-sizing:border-box}",
          ".jdp-btn{border:1px solid var(--dsw-alias-border,rgba(128,128,128,.28));border-radius:6px;padding:5px 12px;background:var(--dsw-alias-btn,rgba(128,128,128,.12));color:inherit;cursor:pointer;font-size:12px}",
          ".jdp-btn:hover{background:var(--dsw-alias-btn-hover,rgba(128,128,128,.22))}",
          ".jdp-btn[disabled]{opacity:.5;cursor:not-allowed}",
          ".jdp-btn-danger{border-color:rgba(220,80,80,.5);color:#d96a6a}",
          ".jdp-btn-accent{border-color:var(--dsw-alias-accent,#4f8cff);color:var(--dsw-alias-accent,#4f8cff)}",
          ".jdp-tabs{display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
          ".jdp-tab{border:1px solid transparent;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:13px;color:var(--dsw-alias-muted,rgba(128,128,128,.9))}",
          ".jdp-tab.active{border-color:var(--dsw-alias-border,rgba(128,128,128,.28));background:var(--dsw-alias-surface,rgba(128,128,128,.08));color:inherit;font-weight:600}",
          ".jdp-switch{display:inline-flex;align-items:center;gap:8px;cursor:pointer;user-select:none}",
          ".jdp-switch .track{width:34px;height:18px;border-radius:9px;background:var(--dsw-alias-border,rgba(128,128,128,.35));position:relative;transition:background .15s}",
          ".jdp-switch.on .track{background:var(--dsw-alias-accent,#4f8cff)}",
          ".jdp-switch .knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:left .15s}",
          ".jdp-switch.on .knob{left:18px}",
          ".jdp-msg{border-radius:6px;padding:8px 10px;font-size:12px;white-space:pre-wrap}",
          ".jdp-msg.err{background:rgba(220,80,80,.12);border:1px solid rgba(220,80,80,.4)}",
          ".jdp-msg.ok{background:rgba(80,180,120,.12);border:1px solid rgba(80,180,120,.4)}",
          ".jdp-status{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12px}",
          ".jdp-status dt{color:var(--dsw-alias-muted,rgba(128,128,128,.9))}",
          ".jdp-status dd{margin:0;word-break:break-all}",
        ].join("\n");
        document.head.appendChild(el);
      } catch (err) {
        try { console.error("dsh-jdpatterns: style injection failed", err); } catch (_) {}
      }
    }

    async function apiFetch(path, method, body) {
      var opts = { method: method || "GET", headers: {} };
      if (body !== undefined) {
        opts.headers["content-type"] = "application/json";
        opts.body = JSON.stringify(body);
      }
      var res = await fetch(API_BASE + path, opts);
      var text = await res.text();
      var json = null;
      try { json = text ? JSON.parse(text) : null; } catch (_) { json = { raw: text }; }
      if (!res.ok) {
        var msg = json && json.error ? json.error : (res.status + " " + res.statusText);
        throw new Error(msg);
      }
      return json;
    }

    function Switch(props) {
      var on = props.on;
      return h("span", {
        className: "jdp-switch" + (on ? " on" : ""),
        role: "switch",
        "aria-checked": on ? "true" : "false",
        tabIndex: 0,
        onClick: props.onChange,
        onKeyDown: function (ev) { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); props.onChange(); } },
      }, [
        h("span", { className: "track", key: "t" }, [h("span", { className: "knob", key: "k" })]),
        h("span", { key: "l" }, props.label),
      ]);
    }

    function JdPatternsSection(_props) {
      var cfgState = React.useState(null);
      var cfg = cfgState[0];
      var setCfg = cfgState[1];
      var activeState = React.useState("java");
      var active = activeState[0];
      var setActive = activeState[1];
      var busyState = React.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var msgState = React.useState(null);
      var msg = msgState[0];
      var setMsg = msgState[1];
      var addingState = React.useState(false);
      var adding = addingState[0];
      var setAdding = addingState[1];
      var formState = React.useState({ remoteUrl: "", localPath: "", indexFile: "", gate: true });
      var form = formState[0];
      var setForm = formState[1];
      var newIdState = React.useState("");
      var newId = newIdState[0];
      var setNewId = newIdState[1];
      var dirtyState = React.useState(false);
      var dirty = dirtyState[0];
      var setDirty = dirtyState[1];

      function note(kind, text) { setMsg({ kind: kind, text: String(text) }); }

      var load = React.useCallback(function () {
        setBusy(true);
        apiFetch("/config")
          .then(function (res) {
            setCfg(res && res.config ? res.config : { gateEnabled: true, languages: {} });
            return apiFetch("/status").catch(function () { return null; });
          })
          .then(function (status) {
            if (status && status.statuses) {
              setCfg(function (prev) { return prev ? Object.assign({}, prev, { _statuses: status.statuses }) : prev; });
            }
          })
          .catch(function (err) { note("err", "加载配置失败：" + err.message); })
          .then(function () { setBusy(false); });
      }, []);

      React.useEffect(function () {
        injectStyles();
        load();
        return undefined;
      }, [load]);

      // 回写修复：配置加载/保存完成、切换语言、进出新建模式时，把表单同步为配置值；
      // 用户正在编辑（dirty）时不覆盖。
      React.useEffect(function () {
        if (!cfg) return;
        if (dirty) return;
        if (adding) {
          setForm({ remoteUrl: "", localPath: "", indexFile: "README.md", gate: true });
          return;
        }
        var e = cfg.languages && cfg.languages[active];
        if (e) {
          setForm({
            remoteUrl: e.remoteUrl || "",
            localPath: e.localPath || "",
            indexFile: e.indexFile || "",
            gate: e.gate !== false,
          });
        }
      }, [cfg, active, adding, dirty]);

      if (!cfg) {
        return h("div", { className: "jdp-root" }, [
          h("div", { key: "l", className: "jdp-hint" }, busy ? "加载中…" : "配置不可用"),
          h("button", { key: "r", className: "jdp-btn", onClick: load }, "重试"),
        ]);
      }

      var languages = cfg.languages || {};
      var langNames = Object.keys(languages);
      var activeEntry = languages[active] || null;
      var statuses = cfg._statuses || [];
      var activeStatus = null;
      for (var i = 0; i < statuses.length; i++) {
        if (statuses[i].language === active) { activeStatus = statuses[i]; break; }
      }

      function saveLanguage(langKey, entry) {
        setBusy(true);
        var next = {
          gateEnabled: cfg.gateEnabled !== false,
          languages: Object.assign({}, languages),
        };
        next.languages[langKey] = entry;
        apiFetch("/config", "PUT", next)
          .then(function (res) {
            setCfg(Object.assign({}, res.config));
            note("ok", "已保存 " + langKey + " 配置");
            return apiFetch("/status").then(function (s) {
              setCfg(function (prev) { return prev ? Object.assign({}, prev, { _statuses: s.statuses }) : prev; });
            }).catch(function () {});
          })
          .catch(function (err) { note("err", "保存失败：" + err.message); })
          .then(function () { setBusy(false); });
      }

      function removeLanguage(langKey) {
        setBusy(true);
        apiFetch("/config?lang=" + encodeURIComponent(langKey), "DELETE")
          .then(function (res) {
            setCfg(Object.assign({}, res.config));
            setActive("java");
            note("ok", "已删除语言 " + langKey);
          })
          .catch(function (err) { note("err", "删除失败：" + err.message); })
          .then(function () { setBusy(false); });
      }

      function toggleGate() {
        setBusy(true);
        apiFetch("/gate", "PUT", { gateEnabled: !(cfg.gateEnabled !== false) })
          .then(function (res) {
            setCfg(Object.assign({}, cfg, { gateEnabled: !!res.gateEnabled }));
            note("ok", res.gateEnabled ? "硬闸门已开启：写受控源码前必须先查模式目录（按各语言开关判定）" : "硬闸门已全局关闭：退回提示词软引导");
          })
          .catch(function (err) { note("err", "切换失败：" + err.message); })
          .then(function () { setBusy(false); });
      }

      function pullRepo() {
        setBusy(true);
        apiFetch("/pull", "POST", { language: active })
          .then(function (res) {
            var r = res && res.result ? res.result : {};
            note("ok", "更新完成：" + (r.merged || "already up to date") + "（分支 " + (r.branch || "?") + "，目录 " + (r.patterns || 0) + " 个模式）");
            load();
          })
          .catch(function (err) { note("err", "更新失败：" + err.message); })
          .then(function () { setBusy(false); });
      }

      var tabs = langNames.map(function (lang) {
        return h("span", {
          key: lang,
          className: "jdp-tab" + (lang === active ? " active" : ""),
          onClick: function () { setActive(lang); setDirty(false); },
        }, lang);
      });
      tabs.push(h("span", {
        key: "add",
        className: "jdp-tab",
        title: "新建自定义语言",
        onClick: function () { setAdding(!adding); setNewId(""); setDirty(false); },
      }, "+"));

      var editorRows = [];
      if (adding) {
        editorRows.push(h("div", { key: "newid", className: "jdp-field" }, [
          h("span", { key: "l" }, "语言标签（^[a-z][a-z0-9-]*$，java 内置不可用）"),
          h("input", { key: "i", className: "jdp-input", value: newId, placeholder: "如 python", onChange: function (ev) { setNewId(ev.target.value); } }),
        ]));
      }
      var editingKey = adding ? newId : active;
      var isBuiltin = !adding && BUILTIN_LANGS.indexOf(active) !== -1;
      if (editingKey) {
        editorRows.push(h("div", { key: "gateflag", className: "jdp-card jdp-row" }, [
          h(Switch, {
            key: "sw", on: form.gate !== false,
            onChange: function () { setForm(Object.assign({}, form, { gate: !(form.gate !== false) })); setDirty(true); },
            label: "本语言硬闸门（写 " + gateExts(editingKey).join(" / ") + " 前强制先查模式目录）",
          }),
          h("span", { key: "hint", className: "jdp-hint" }, form.gate !== false ? "受全局闸门开关约束；全局关闭时一律放行。" : "已对本语言关闭，写入不受拦截。"),
        ]));
        editorRows.push(h("div", { key: "remoteUrl", className: "jdp-field" }, [
          h("span", { key: "l" }, "项目开源地址（git remote，用于说明）"),
          h("input", { key: "i", className: "jdp-input", value: form.remoteUrl, onChange: function (ev) { setForm(Object.assign({}, form, { remoteUrl: ev.target.value })); setDirty(true); } }),
        ]));
        editorRows.push(h("div", { key: "localPath", className: "jdp-field" }, [
          h("span", { key: "l" }, "项目本地地址（git 仓库绝对路径）"),
          h("input", { key: "i", className: "jdp-input", value: form.localPath, placeholder: "如 F:\\project\\java-design-patterns", onChange: function (ev) { setForm(Object.assign({}, form, { localPath: ev.target.value })); setDirty(true); } }),
        ]));
        editorRows.push(h("div", { key: "indexFile", className: "jdp-field" }, [
          h("span", { key: "l" }, "目录索引文件相对路径（## 分类 + [名称](./模块) 链接）"),
          h("input", { key: "i", className: "jdp-input", value: form.indexFile, onChange: function (ev) { setForm(Object.assign({}, form, { indexFile: ev.target.value })); setDirty(true); } }),
        ]));
        editorRows.push(h("div", { key: "actions", className: "jdp-row", style: { marginTop: 12 } }, [
          h("button", {
            key: "save", className: "jdp-btn jdp-btn-accent", disabled: busy || (adding && !LANG_RE.test(newId)),
            onClick: function () {
              var key = adding ? newId : active;
              if (adding && !LANG_RE.test(newId)) { note("err", "语言标签不合法：需 ^[a-z][a-z0-9-]*$"); return; }
              if (adding && BUILTIN_LANGS.indexOf(newId) !== -1) { note("err", "java 为内置语言标签"); return; }
              saveLanguage(key, { remoteUrl: form.remoteUrl, localPath: form.localPath, indexFile: form.indexFile || (key === "java" ? "PATTERNS.zh.md" : "README.md"), gate: form.gate !== false });
              setDirty(false);
              if (adding) { setAdding(false); setActive(key); }
            },
          }, adding ? "创建语言" : "保存"),
          (!adding && !isBuiltin) ? h("button", { key: "del", className: "jdp-btn jdp-btn-danger", disabled: busy, onClick: function () { removeLanguage(active); } }, "删除该语言") : null,
          (!adding) ? h("button", { key: "pull", className: "jdp-btn", disabled: busy, onClick: pullRepo }, "拉取更新（ff-only）") : null,
        ].filter(Boolean)));
      }

      var statusRows = [];
      if (!adding && activeStatus) {
        statusRows = [
          ["本地路径", activeStatus.localPath || "（未配置）"],
          ["目录存在", activeStatus.exists ? "是" : "否"],
          ["git 仓库", activeStatus.git ? "是" : "否"],
          ["当前分支", activeStatus.branch || "—"],
          ["目录模式数", String(activeStatus.patterns || 0)],
          ["索引文件", activeStatus.indexFile || "—"],
          ["索引解析", activeStatus.indexError ? ("失败：" + activeStatus.indexError) : "正常"],
        ].map(function (row, idx) {
          return [h("dt", { key: "k" + idx }, row[0]), h("dd", { key: "v" + idx }, row[1])];
        });
      }

      // 全局开关标签：按当前配置汇总所有开启闸门的语言的受控扩展名
      var gatedExts = [];
      for (var gi = 0; gi < langNames.length; gi++) {
        var gLang = langNames[gi];
        var gEntry = languages[gLang];
        if (gEntry && gEntry.gate !== false) {
          var ge = gateExts(gLang);
          for (var gj = 0; gj < ge.length; gj++) { if (gatedExts.indexOf(ge[gj]) === -1) gatedExts.push(ge[gj]); }
        }
      }
      var gateLabel = gatedExts.length > 0
        ? "硬闸门（写 " + gatedExts.join(" / ") + " 前强制先查设计模式目录）"
        : "硬闸门（当前所有语言均已关闭各自闸门）";

      return h("div", { className: "jdp-root" }, [
        h("div", { key: "gate", className: "jdp-card jdp-row" }, [
          h(Switch, { key: "sw", on: cfg.gateEnabled !== false, onChange: toggleGate, label: gateLabel }),
          h("span", { key: "hint", className: "jdp-hint" }, cfg.gateEnabled !== false ? "执行层拦截，无法绕过；查过目录自动放行；故障自动放行。按各语言开关判定。" : "已关闭，仅系统提示软引导。"),
        ]),
        h("div", { key: "langs", className: "jdp-card" }, [
          h("div", { key: "tabs", className: "jdp-tabs" }, tabs),
          h("div", { key: "editor" }, editorRows),
        ]),
        (!adding && activeStatus) ? h("div", { key: "status", className: "jdp-card" }, [
          h("div", { key: "t", className: "jdp-label" }, "仓库状态 · " + active),
          h("dl", { key: "dl", className: "jdp-status", style: { marginTop: 8 } }, [].concat.apply([], statusRows)),
        ]) : null,
        msg ? h("div", { key: "msg", className: "jdp-msg " + (msg.kind === "err" ? "err" : "ok") }, msg.text) : null,
      ]);
    }

    var inject = ["slots"];

    function apply(ctx) {
      try {
        ctx.slots.inject("settings.section", function () {
          return ctx.slots.register({
            name: "settings.section",
            id: "jdpatterns",
            order: 200,
            label: function () { return "设计模式参考库"; },
          }, JdPatternsSection);
        });
      } catch (error) {
        try { console.error("dsh-jdpatterns: client apply failed", error); } catch (_) {}
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
