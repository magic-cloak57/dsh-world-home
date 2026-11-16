/**
 * dsh-world — 浏览器半侧：设置里的「世界控制台」。
 * 模块 id 必须等于 bundle 行名 dsh-world；数据来自宿主半侧的 /dsh-world/console/* 路由。
 * 读取是 GET；会改变东西的（开始、停止、人设、家的说明书、额度、记忆轮数）是带 x-dsh-world 头的 JSON POST。
 */
window.__ModuleLoader__.load({
  id: 'dsh-world-home',
  factory: (require) => {
    var react = require('react')
    var h = react.createElement
    var useState = react.useState
    var useEffect = react.useEffect
    var useRef = react.useRef

    function settle(r) {
      return r.json().then(function (body) { return { body: body } }, function () { return null }).then(function (parsed) {
        var body = parsed && parsed.body
        if (!r.ok) { var err = new Error((body && body.error) || ('HTTP ' + r.status)); err.status = r.status; throw err }
        if (!parsed) { var bad = new Error('回复不是 JSON'); bad.notJson = true; throw bad }
        return body
      })
    }
    function api(path) { return fetch('/dsh-world/console/' + path, { cache: 'no-store' }).then(settle) }
    function post(path, body) {
      return fetch('/dsh-world/console/' + path, { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json', 'x-dsh-world': '1' }, body: JSON.stringify(body || {}) }).then(settle)
    }
    /** QQ 那几扇门在自己的前缀下（/dsh-world/qq/*），不和 console 混在一起。 */
    function qqGet(path) { return fetch('/dsh-world/qq/' + path, { cache: 'no-store' }).then(settle) }
    function qqPost(path, body) {
      return fetch('/dsh-world/qq/' + path, { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json', 'x-dsh-world': '1' }, body: JSON.stringify(body || {}) }).then(settle)
    }
    /** 快照，或 null 表示控制台不在（404、不是 JSON 的页面、没有 life 字段的回复）。 */
    function loadSnapshot() {
      return api('snapshot').then(function (s) {
        return s && typeof s === 'object' && typeof s.life === 'object' ? s : null
      }, function (e) { if (e && (e.status === 404 || e.notJson)) return null; throw e })
    }
    function clock(iso, zone) {
      try { return new Date(iso).toLocaleTimeString('zh-CN', { timeZone: zone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }) } catch (e) { return String(iso) }
    }
    function local(iso, zone) {
      if (!iso) return '—'
      try { return new Date(iso).toLocaleString('zh-CN', { timeZone: zone, hourCycle: 'h23', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) } catch (e) { return iso }
    }
    function remaining(iso) {
      var ms = Date.parse(iso) - Date.now()
      if (!(ms > 0)) return '马上'
      var m = Math.round(ms / 60000), d = Math.floor(m / 1440), hr = Math.floor(m % 1440 / 60), mi = m % 60
      return (d ? d + ' 天 ' : '') + (hr ? hr + ' 小时 ' : '') + mi + ' 分'
    }
    function list(value) { return Array.isArray(value) ? value : [] }
    var sourceLabel = { first: '新家', return: '回来', plan: '闹钟', fallback: '早上兜底', review: '回顾', manual: '手动' }
    var statusLabel = { running: '正在做事', idle: '空闲', cold: '休息中' }

    var LAYERS = [
      { key: '名字', hint: '她叫什么。', rows: 1 },
      { key: '一句话', hint: '一句话说清她是谁、处在什么处境。', rows: 2 },
      { key: '我在意什么', hint: '两三条，每条写清“为什么在意”，别只写形容词。', rows: 5 },
      { key: '我怎么说话', hint: '句长、语气、接不接话——写成能照做的规则。', rows: 5 },
      { key: '说话的例子', hint: '两三段短对话，示范她的语气。这一节最管用。', rows: 8 },
      { key: '我不会做的事', hint: '三条硬约束。', rows: 4 },
      { key: '收尾', hint: '告诉她这只是起点，可以改。', rows: 3 }
    ]
    /** 和宿主半侧 renderPersona 一样拼：她读到的就是这段。 */
    function renderPersona(p) {
      var parts = []
      ;['名字', '一句话', '我在意什么', '我怎么说话', '说话的例子', '我不会做的事', '收尾'].forEach(function (k) {
        var v = (p[k] || '').trim()
        if (v) parts.push('## ' + k + '\n' + v)
      })
      return parts.length ? '# 我是谁\n\n' + parts.join('\n\n') + '\n' : ''
    }

    var CSS = [
      '.dw{--ink:var(--dsw-alias-label-primary,#2a2620);--soft:var(--dsw-alias-label-tertiary,#8b8475);--gold:#c49a52;',
      '--line:color-mix(in srgb,currentColor 13%,transparent);--paper:color-mix(in srgb,currentColor 3.5%,transparent);',
      '--glow:color-mix(in srgb,var(--gold) 22%,transparent);--warn:#c4553a;--serif:"Noto Serif SC","Source Han Serif SC","Songti SC","STSong","SimSun",serif;',
      'max-width:780px;display:flex;flex-direction:column;gap:18px;font-size:13px;line-height:1.65;color:var(--ink)}',
      '.dw *{box-sizing:border-box}',
      '.dw-head{position:relative;display:flex;align-items:flex-end;gap:16px;padding:18px 20px 16px;border:1px solid var(--line);border-radius:14px;',
      'background:radial-gradient(120% 140% at 100% 0%,var(--glow),transparent 55%),var(--paper);overflow:hidden}',
      '.dw-head:after{content:"";position:absolute;left:20px;right:20px;bottom:0;height:1px;background:linear-gradient(90deg,transparent,var(--gold),transparent);opacity:.55}',
      '.dw-title{flex:1;min-width:0}.dw-title small{display:block;letter-spacing:.24em;font-size:10px;text-transform:uppercase;color:var(--soft)}',
      '.dw-title h2{margin:2px 0 0;font:600 24px/1.25 var(--serif);letter-spacing:.04em}',
      '.dw-state{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--soft);margin-top:6px}',
      '.dw-dot{width:8px;height:8px;border-radius:50%;background:var(--soft);opacity:.6}',
      '.dw-on .dw-dot{background:var(--gold);opacity:1;box-shadow:0 0 0 0 var(--glow);animation:dw-breathe 2.6s ease-in-out infinite}',
      '@keyframes dw-breathe{0%,100%{box-shadow:0 0 0 0 var(--glow)}50%{box-shadow:0 0 0 7px transparent}}',
      '.dw-power{font:600 13px var(--serif);letter-spacing:.2em;padding:9px 20px 9px 22px;border-radius:999px;cursor:pointer;transition:transform .15s,box-shadow .2s,background .2s;',
      'border:1px solid var(--gold);background:var(--gold);color:#fffaf0;box-shadow:0 6px 18px -8px var(--gold)}',
      '.dw-power:hover{transform:translateY(-1px);box-shadow:0 10px 22px -8px var(--gold)}',
      '.dw-power.stop{background:transparent;color:var(--ink);border-color:var(--line);box-shadow:none}.dw-power.stop:hover{border-color:var(--warn);color:var(--warn)}',
      '.dw-power:disabled{opacity:.5;cursor:default;transform:none}',
      '.dw-tabs{display:flex;gap:4px;border-bottom:1px solid var(--line);padding:0 6px}',
      '.dw-tab{position:relative;font:500 13px var(--serif);letter-spacing:.12em;padding:8px 14px 10px;background:none;border:0;color:var(--soft);cursor:pointer}',
      '.dw-tab:after{content:"";position:absolute;left:50%;right:50%;bottom:-1px;height:2px;background:var(--gold);transition:left .25s,right .25s}',
      '.dw-tab.on{color:var(--ink)}.dw-tab.on:after{left:12px;right:12px}',
      '.dw-pane{display:flex;flex-direction:column;gap:14px}',
      '.dw-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}',
      '.dw-card{min-width:0;border:1px solid var(--line);border-radius:12px;padding:14px 16px;background:var(--paper);animation:dw-rise .45s both}',
      '@keyframes dw-rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}',
      '.dw-card h4{margin:0 0 10px;font:600 13px var(--serif);letter-spacing:.14em;display:flex;align-items:center;gap:8px}',
      '.dw-card h4:before{content:"";width:14px;height:1px;background:var(--gold)}',
      '.dw-kv{display:grid;grid-template-columns:auto 1fr;gap:4px 14px}.dw-kv dt{color:var(--soft);white-space:nowrap}.dw-kv dd{margin:0;min-width:0;overflow-wrap:anywhere}',
      '.dw-big{font:600 20px/1.2 var(--serif)}.dw-muted{color:var(--soft)}.dw-bad{color:var(--warn)}.dw-ok{color:var(--gold)}',
      '.dw-quote{border-left:2px solid var(--gold);padding:2px 0 2px 10px;margin:8px 0 0;font-family:var(--serif)}',
      '.dw-meter{height:4px;border-radius:4px;background:var(--line);overflow:hidden;margin:8px 0 4px}.dw-meter i{display:block;height:100%;background:linear-gradient(90deg,var(--gold),color-mix(in srgb,var(--gold) 55%,#fff))}',
      '.dw-trail{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:4px}.dw-trail span{display:inline-flex;align-items:center;gap:6px}.dw-trail span:before{content:"";width:5px;height:5px;border-radius:50%;background:var(--gold)}',
      '.dw-welcome{text-align:center;padding:30px 20px}.dw-welcome h3{font:600 20px var(--serif);margin:0 0 8px;letter-spacing:.06em}',
      '.dw-steps{display:inline-flex;flex-direction:column;gap:6px;text-align:left;margin-top:12px;counter-reset:s}',
      '.dw-steps li{list-style:none;counter-increment:s;display:flex;gap:10px}.dw-steps li:before{content:counter(s);font:600 12px var(--serif);color:var(--gold);border:1px solid var(--gold);border-radius:50%;width:20px;height:20px;display:inline-grid;place-items:center;flex:none}',
      '.dw-layer{display:grid;grid-template-columns:96px 1fr;gap:4px 16px;padding:14px 0;border-bottom:1px dashed var(--line)}',
      '.dw-layer:last-child{border-bottom:0}.dw-layer label{font:600 14px var(--serif);letter-spacing:.1em;padding-top:6px}',
      '.dw-layer small{grid-column:2;color:var(--soft);font-size:11.5px}',
      '.dw textarea,.dw input[type=text]{width:100%;font:inherit;color:inherit;background:color-mix(in srgb,currentColor 2%,transparent);border:1px solid var(--line);border-radius:8px;padding:8px 10px;resize:vertical;transition:border-color .2s,box-shadow .2s}',
      '.dw textarea:focus,.dw input[type=text]:focus{outline:none;border-color:var(--gold);box-shadow:0 0 0 3px var(--glow)}',
      '.dw input.dw-name{font:600 18px var(--serif);letter-spacing:.06em}',
      '.dw-code{font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-size:12px;line-height:1.6;min-height:340px}',
      '.dw-bar{position:sticky;bottom:0;display:flex;align-items:center;gap:10px;padding:10px 0 2px;background:linear-gradient(transparent,var(--dsw-alias-background-primary,transparent) 40%)}',
      '.dw-btn{flex-shrink:0;white-space:nowrap;font:inherit;cursor:pointer;border:1px solid var(--line);background:transparent;color:inherit;border-radius:8px;padding:6px 14px;transition:border-color .2s,background .2s}',
      '.dw-btn:hover{border-color:var(--gold)}.dw-btn.primary{background:var(--gold);border-color:var(--gold);color:#fffaf0}.dw-btn:disabled{opacity:.45;cursor:default}',
      '.dw-preview{white-space:pre-wrap;font-family:var(--serif);font-size:12.5px;margin:0;max-height:260px;overflow:auto}',
      '.dw-chip{display:inline-block;font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid var(--line);color:var(--soft)}',
      '.dw table{width:100%;border-collapse:collapse}.dw td{padding:3px 6px;vertical-align:top;border-bottom:1px solid color-mix(in srgb,currentColor 6%,transparent)}',
      '.dw-activity{table-layout:fixed}.dw-activity td{overflow:hidden;overflow-wrap:anywhere}.dw-activity td:first-child{white-space:nowrap}',
      '.dw-clamp{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-size:12px}',
      '.dw-setting{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;align-items:center}.dw-setting input[type=text]{flex:1 1 120px;max-width:200px;min-width:0}',
      '.dw-setting select{flex:1 1 140px;max-width:100%;min-width:0}',
      '.dw pre.dw-diary{white-space:pre-wrap;margin:10px 0 0;font-family:var(--serif)}',
      '.dw select{font:inherit;color:inherit;background:transparent;border:1px solid var(--line);border-radius:6px;padding:2px 6px}',
      '@media (prefers-reduced-motion:reduce){.dw *{animation:none!important;transition:none!important}}',
    ].join('')
    function ensureStyle() {
      if (document.getElementById('dsh-world-console-style')) return
      var tag = document.createElement('style'); tag.id = 'dsh-world-console-style'; tag.textContent = CSS; document.head.appendChild(tag)
    }

    function Card(props) {
      return h('section', { className: 'dw-card', style: { animationDelay: (props.delay || 0) + 'ms' } }, props.title ? h('h4', null, props.title) : null, props.children)
    }
    function KV(rows) {
      return h('dl', { className: 'dw-kv' }, rows.filter(Boolean).map(function (row, i) { return [h('dt', { key: 'k' + i }, row[0]), h('dd', { key: 'v' + i }, row[1])] }))
    }

    function Activity(props) {
      var days = props.days, zone = props.zone
      var dayState = useState(days[0] || ''), day = dayState[0], setDay = dayState[1]
      var outsideState = useState(false), outside = outsideState[0], setOutside = outsideState[1]
      var rowsState = useState([]), rows = rowsState[0], setRows = rowsState[1]
      var errState = useState(null), err = errState[0], setErr = errState[1]
      useEffect(function () {
        if (!day) return
        var alive = true
        api('activity?day=' + encodeURIComponent(day) + (outside ? '&outside=1' : '')).then(
          function (r) { if (alive) { setRows(r); setErr(null) } },
          function (e) { if (alive) { setRows([]); setErr(String(e.message || e)) } })
        return function () { alive = false }
      }, [day, outside, props.tick])
      return h(Card, { title: '活动记录' },
        days.length === 0 ? h('div', { className: 'dw-muted' }, '还没有活动记录') : h('div', null,
          h('select', { value: day, onChange: function (e) { setDay(e.target.value) }, style: { padding: '4px 8px', borderRadius: 6, background: '#2a2f3a', color: '#f2f3f5', border: '1px solid rgba(127,127,127,.45)', fontSize: 13 } }, days.map(function (d) { return h('option', { key: d, value: d }, d) })),
          ' ', h('label', { className: 'dw-muted' }, h('input', { type: 'checkbox', checked: outside, onChange: function (e) { setOutside(e.target.checked) } }), ' 只看房间外'),
          err ? h('div', { className: 'dw-bad' }, '读取失败：' + err) : null,
          h('table', { className: 'dw-activity' },
            h('colgroup', null, h('col', { style: { width: 48 } }), h('col', { style: { width: '22%' } }), h('col'), h('col', { style: { width: 40 } }), h('col', { style: { width: 64 } })),
            h('tbody', null, rows.map(function (r) {
            return h('tr', { key: r.callId + r.time }, h('td', { className: 'dw-muted' }, clock(r.time, zone)), h('td', null, r.tool), h('td', { title: r.summary }, h('div', { className: 'dw-clamp' }, r.summary)), h('td', { className: 'dw-bad' }, r.status === 'error' ? '失败' : ''), h('td', { className: r.outside ? 'dw-bad' : 'dw-muted' }, (r.gapBefore ? '（此前有缺口）' : '') + (r.outside ? '房间外' : '')))
          })))))
    }
    function Diary(props) {
      var openState = useState(null), open = openState[0], setOpen = openState[1]
      var textState = useState(''), text = textState[0], setText = textState[1]
      var errState = useState(null), err = errState[0], setErr = errState[1]
      var wanted = useRef(null)
      function show(date) {
        wanted.current = date; setOpen(date); setText(''); setErr(null)
        api('diary?date=' + encodeURIComponent(date)).then(
          function (b) { if (wanted.current === date) setText(String(b.text || '')) },
          function (e) { if (wanted.current === date) setErr(String(e.message || e)) })
      }
      return h(Card, { title: '日记' },
        props.dates.length === 0 ? h('div', { className: 'dw-muted' }, '还没有日记') : h('div', null,
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } }, props.dates.map(function (d) { return h('button', { key: d, className: 'dw-btn' + (open === d ? ' primary' : ''), onClick: function () { show(d) } }, d) })),
          err ? h('div', { className: 'dw-bad' }, '读取失败：' + err) : null,
          open && !err ? h('pre', { className: 'dw-diary' }, text) : null))
    }

    /** 她的相册：keep_photo 留下的照片，和她当时写的话。照片点开才去取字节。 */
    /** 分层人设：每层一张卡，右边是她实际读到的样子。 */
    function PersonaEditor(props) {
      var state = useState(null), persona = state[0], setPersona = state[1]
      var savedState = useState(null), saved = savedState[0], setSaved = savedState[1]
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      var busyState = useState(false), busy = busyState[0], setBusy = busyState[1]
      var presetsState = useState(null), presets = presetsState[0], setPresets = presetsState[1]
      var pickedState = useState(''), picked = pickedState[0], setPicked = pickedState[1]
      useEffect(function () {
        api('prompts').then(function (b) { setPersona(b.persona); setSaved(b.persona) }, function (e) { setMsg('读取失败：' + (e.message || e)) })
        api('persona-presets').then(function (b) { setPresets((b && b.presets) || []) }, function () { setPresets([]) })
      }, [])
      if (!persona) return h('div', { className: 'dw-muted' }, msg || '读取中…')
      var dirty = JSON.stringify(persona) !== JSON.stringify(saved)
      function set(key, value) { var next = Object.assign({}, persona); next[key] = value; setPersona(next); setMsg('') }
      function save() {
        setBusy(true)
        post('persona', persona).then(function () { setSaved(persona); setMsg('已保存。下次开始对话或压缩之后，她就照这份来。'); if (props.onSaved) props.onSaved() },
          function (e) { setMsg('保存失败：' + (e.message || e)) }).then(function () { setBusy(false) })
      }
      var PRINT_LAYERS = ['一句话', '我在意什么', '我怎么说话', '说话的例子', '我不会做的事', '收尾']
      function buildBody(p) {
        return PRINT_LAYERS.filter(function (k) { return (p[k] || '').trim() }).map(function (k) { return '## ' + k + '\n' + p[k].trim() }).join('\n\n')
      }
      function applyBody(text) {
        var next = Object.assign({}, persona)
        PRINT_LAYERS.forEach(function (k) { next[k] = '' })
        var parts = String(text || '').split(/^##\s*(.+)$/m)
        for (var i = 1; i < parts.length; i += 2) {
          var key = (parts[i] || '').trim()
          var value = (parts[i + 1] || '').trim()
          if (PRINT_LAYERS.indexOf(key) >= 0) next[key] = value
          else next['收尾'] = ((next['收尾'] || '') + '\n' + value).trim()
        }
        setPersona(next); setMsg('')
      }
      var bodyText = buildBody(persona)
      function applyPreset(preset) {
        setPicked(preset.id)
        if (!preset.layers) {
          var blank = Object.assign({}, persona)
          Object.keys(blank).forEach(function (k) { blank[k] = '' })
          setPersona(blank)
          setMsg('已清空。保存之后就没有人设种子了——原来的《我是谁》一个字都不会被动。')
          return
        }
        setPersona(Object.assign({}, persona, preset.layers))
        setMsg('已套用「' + preset.label + '」。看着顺眼就点保存；想改哪句直接改下面的栏。')
      }
      return h('div', { className: 'dw-pane' },
        h(Card, { title: '她的名字' },
          h('input', {
            type: 'text', className: 'dw-name', placeholder: '比如：小蓝',
            value: persona['名字'] || '',
            onChange: function (e) { set('名字', e.target.value) }
          })),
        h(Card, { title: '从预设开始（可选）' },
          h('div', { className: 'dw-muted', style: { marginBottom: 8 } }, '这里只是起点：套用以后可以随手改，也可以不选，直接从下面写自己的。'),
          presets === null ? h('div', { className: 'dw-muted' }, '读取中…') : presets.length === 0 ? h('div', { className: 'dw-muted' }, '没有读到你预设文件（presets\\seed-personas.json）。') :
          h('div', { style: { display: 'grid', gap: 8 } }, presets.map(function (preset) {
            var on = picked === preset.id
            return h('button', {
              key: preset.id,
              onClick: function () { applyPreset(preset) },
              style: {
                textAlign: 'left', padding: '8px 10px', borderRadius: 8, cursor: 'pointer',
                background: on ? 'rgba(90,150,255,.22)' : '#2a2f3a',
                color: '#f2f3f5',
                border: on ? '1px solid rgba(120,180,255,.75)' : '1px solid rgba(127,127,127,.45)',
                fontSize: 13
              }
            }, h('b', null, preset.label), h('div', { className: 'dw-muted' }, preset.hint))
          }))),
        h(Card, { title: '她读到的样子（可以直接改）' },
          h('textarea', {
            rows: 18,
            style: { width: '100%', fontFamily: 'inherit', lineHeight: 1.6 },
            value: bodyText,
            onChange: function (e) { applyBody(e.target.value) },
            placeholder: '想让她是什么样，就在这儿写。分节用「## 性格」这样的标题。'
          }),
          h('div', { className: 'dw-muted', style: { marginTop: 6 } }, '这一段就是她打开家时读到的话；写空也行，那就用插件自带的人设。')),
        h('div', { className: 'dw-bar' },
          h('button', { className: 'dw-btn primary', disabled: !dirty || busy, onClick: save }, busy ? '保存中…' : '保存人设'),
          h('span', { className: msg.indexOf('失败') >= 0 ? 'dw-bad' : 'dw-muted' }, msg || (dirty ? '有改动还没保存' : ''))))
    }
    /** 家的说明书模板：自己的一份，或插件自带的。 */
    function PromptEditor() {
      var state = useState(null), prompt = state[0], setPrompt = state[1]
      var textState = useState(''), text = textState[0], setText = textState[1]
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      function load() { api('prompts').then(function (b) { setPrompt(b.worldPrompt); setText(b.worldPrompt.text) }, function (e) { setMsg('读取失败：' + (e.message || e)) }) }
      useEffect(load, [])
      if (!prompt) return h('div', { className: 'dw-muted' }, msg || '读取中…')
      function save(value, done) {
        post('world-prompt', { text: value }).then(function () { setMsg(done); load() }, function (e) { setMsg('保存失败：' + (e.message || e)) })
      }
      return h('div', { className: 'dw-pane' },
        h(Card, { title: '家的说明书' },
          h('div', { style: { marginBottom: 8 } }, h('span', { className: 'dw-chip' }, prompt.custom ? '你自己的一份' : '插件自带'), ' ',
            h('span', { className: 'dw-muted' }, '可用 {{name}} {{partner}} {{homeTitle}} {{roomDir}} {{diaryDir}} {{selfFile}} {{self}} 和 {{#home}}…{{/home}} 等，见 README')),
          h('textarea', { className: 'dw-code', value: text, onChange: function (e) { setText(e.target.value); setMsg('') } })),
        h('div', { className: 'dw-bar' },
          h('button', { className: 'dw-btn primary', disabled: text === prompt.text, onClick: function () { save(text, '已保存。下次开始对话或压缩之后生效。') } }, '保存'),
          prompt.custom ? h('button', { className: 'dw-btn', onClick: function () { if (window.confirm('删掉你自己的这份，换回插件自带的模板？')) save('', '已换回插件自带的模板。') } }, '恢复默认') : null,
          h('span', { className: msg.indexOf('失败') >= 0 ? 'dw-bad' : 'dw-muted' }, msg)))
    }

    /** 今天家里花了多少，和每天的额度（留空不限）。 */
    function Budget(props) {
      var budget = props.budget || {}, daily = budget.daily, today = budget.today
      var spent = today ? today.yuan : 0
      var draftState = useState(daily == null ? '' : String(daily)), draft = draftState[0], setDraft = draftState[1]
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      function save() {
        var text = String(draft).trim(), value = text === '' ? null : Number(text)
        if (value !== null && !(value >= 0)) { setMsg('请填一个不小于 0 的数，或留空表示不限'); return }
        post('budget', { daily: value }).then(function () { setMsg(value === null ? '已改为不限' : '已保存'); if (props.onSaved) props.onSaved() }, function (e) { setMsg('保存失败：' + (e.message || e)) })
      }
      var over = daily != null && spent >= daily
      return h(Card, { title: '今日花费', delay: 240 },
        h('div', null, h('span', { className: 'dw-big' + (over ? ' dw-bad' : '') }, '¥' + spent.toFixed(2)), h('span', { className: 'dw-muted' }, daily == null ? ' · 不限额' : ' / ¥' + Number(daily).toFixed(2) + ' 每天')),
        daily != null ? h('div', { className: 'dw-meter' }, h('i', { style: { width: Math.min(100, daily > 0 ? Math.round(spent / daily * 100) : 100) + '%' } })) : null,
        h('div', { className: 'dw-muted', style: { marginTop: 4 } }, '和鲸鱼挂件账本同源（余额真实扣费）；没装挂件时才按官方价估算。超过后提醒她一次。'),
        h('div', { className: 'dw-setting' },
          h('input', { type: 'text', inputMode: 'decimal', placeholder: '每天额度（元），留空不限', value: draft, onChange: function (e) { setDraft(e.target.value); setMsg('') } }),
          h('button', { className: 'dw-btn', onClick: save }, '保存')),
        msg ? h('div', { className: msg.indexOf('失败') >= 0 || msg.indexOf('请填') >= 0 ? 'dw-bad' : 'dw-muted' }, msg) : null)
    }
    /** 第一次用：扫这台电脑的盘，点一块就把家放在那儿（插件自己生成 dsh-world\worlds）；运行中锁住。 */
    function DrivePicker(props) {
      var running = props.running
      var st = useState(null), drives = st[0], setDrives = st[1]
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      var busyState = useState(''), busy = busyState[0], setBusy = busyState[1]
      function scan() {
        api('drives').then(function (r) { setDrives(r.drives || []) }, function (e) { setMsg('扫盘失败：' + (e.message || e)) })
      }
      useEffect(function () { scan() }, [])
      function choose(letter) {
        if (running || busy) return
        setBusy(letter)
        post('home-location', { drive: letter }).then(function (r) {
          setMsg(r.message || '已记下'); setBusy('')
        }, function (e) { setMsg('没记成：' + (e.message || e)); setBusy('') })
      }
      return h('div', { style: { marginTop: 12 } },
        h('div', { className: 'dw-muted' }, running
          ? '家放在哪：运行中不能改，先按上面的「停止」再选。'
          : '第一次用？挑一块盘放家——插件会在那块盘上生成 dsh-world\\worlds。'),
        drives === null ? h('div', { className: 'dw-muted' }, '正在扫盘……')
          : drives.length === 0 ? h('div', { className: 'dw-muted' }, '没扫到盘')
            : h('div', { className: 'dw-setting' }, drives.map(function (d) {
              var label = d.letter + ' 盘' + (d.totalGB ? '：' + Math.round(d.totalGB) + ' GB · 剩 ' + Math.round(d.freeGB || 0) + ' GB' : '')
              return h('button', {
                key: d.letter, className: 'dw-btn', disabled: running || !!busy,
                style: running ? { opacity: 0.45, cursor: 'not-allowed' } : null,
                onClick: function () { choose(d.letter) },
              }, busy === d.letter ? '记下中…' : label)
            })),
        msg ? h('div', { className: 'dw-muted' }, msg) : null)
    }
    /** 记忆块带最近几轮：默认 200，下次开始对话或压缩之后生效。 */
    function Memory(props) {
      var mem = props.mem, window_ = mem && mem.windowTurns || 200
      var activeScope = mem && mem.archiveScope || 'workspace'
      var scopeNames = { home: '仅家会话', workspace: '家所在工作区' }
      var scopeState = useState(mem && mem.selectedArchiveScope || activeScope), scope = scopeState[0], setScope = scopeState[1]
      var draftState = useState(String(window_)), draft = draftState[0], setDraft = draftState[1]
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      function save() {
        var text = String(draft).trim(), value = text === '' ? null : Number(text)
        if (value !== null && !(Number.isInteger(value) && value >= 1)) { setMsg('请填一个不小于 1 的整数，留空恢复默认 200'); return }
        post('memory', { turns: value }).then(function () { setMsg('已保存。下次开始对话或压缩之后生效。'); if (value === null) setDraft('200'); if (props.onSaved) props.onSaved() }, function (e) { setMsg('保存失败：' + (e.message || e)) })
      }
      function saveScope() {
        post('archive-scope', { scope: scope }).then(function (result) {
          setMsg(result.restartRequired ? '已保存。请重启 DSH，启动后按新范围和消息时间重建记忆块。' : '归档范围已保存。')
          if (props.onSaved) props.onSaved()
        }, function (e) { setMsg('保存失败：' + (e.message || e)) })
      }
      return h(Card, { title: '记忆', delay: 180 }, mem ? [
        h('div', { key: 'm' }, h('span', { className: 'dw-big' }, mem.turns), h('span', { className: 'dw-muted' }, ' / ' + window_ + ' 轮')),
        h('div', { key: 'b', className: 'dw-meter' }, h('i', { style: { width: Math.min(100, Math.round((mem.turns || 0) / window_ * 100)) + '%' } })),
        h('div', { key: 'd', className: 'dw-muted' }, '约 ' + mem.approxTokens + ' token · 归档 ' + mem.records + ' 条 · 来自 ' + mem.sessions + ' 个会话'),
        h('div', { key: 'active', className: 'dw-muted' }, '当前归档：' + scopeNames[activeScope]),
        h('div', { key: 'scope', className: 'dw-setting' },
          h('select', { value: scope, 'aria-label': '记忆归档范围', onChange: function (e) { setScope(e.target.value); setMsg('') }, style: { maxWidth: 460, padding: '4px 8px', borderRadius: 6, background: '#2a2f3a', color: '#f2f3f5', border: '1px solid rgba(127,127,127,.45)', fontSize: 13 } },
            h('option', { value: 'home' }, '仅家会话'), h('option', { value: 'workspace' }, '家所在工作区')),
          h('button', { className: 'dw-btn', onClick: saveScope }, '保存范围')),
        mem.restartRequired ? h('div', { key: 'restart', className: 'dw-muted', role: 'status' }, '范围已修改，请重启 DSH。重启前继续使用当前范围。') : null,
        h('div', { key: 's', className: 'dw-setting' },
          h('input', { type: 'text', inputMode: 'numeric', 'aria-label': '记忆带最近几轮', placeholder: '最近几轮，留空为 200', value: draft, onChange: function (e) { setDraft(e.target.value); setMsg('') } }),
          h('button', { className: 'dw-btn', onClick: save }, '保存')),
        msg ? h('div', { key: 'x', className: msg.indexOf('失败') >= 0 || msg.indexOf('请填') >= 0 ? 'dw-bad' : 'dw-muted' }, msg) : null,
      ] : h('div', { className: 'dw-muted' }, '—'))
    }
    /** 微信：适配器每约 2 秒来问一次，最近一次来问的时间就是连接状态；两个读取参数在它下次来问时同步。 */
    function Wechat(props) {
      var w = props.wechat, zone = props.zone
      var contextState = useState(String(w.contextMessages)), context = contextState[0], setContext = contextState[1]
      var bufferState = useState(String(w.bufferSeconds)), buffer = bufferState[0], setBuffer = bufferState[1]
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      var age = w.lastContactAt ? Date.now() - new Date(w.lastContactAt).getTime() : null
      var contacted = age != null && age < 30000, offline = contacted && w.account === 'offline'
      var ad = w.adapter
      var blocked = ad && ad.needsHuman
      var stateText = blocked ? '● 有消息待核对，适配器已停' : !contacted ? (ad && ad.running ? '● 适配器启动中' : ad && ad.error ? '● 等待适配器文件' : w.lastContactAt ? '● 适配器已断开' : '● 等待适配器') : offline ? '● 微信离线，等待重新登录' : '● 已连接'
      var adMsgState = useState(''), adMsg = adMsgState[0], setAdMsg = adMsgState[1]
      function restartAdapter() {
        setAdMsg('正在重启…')
        post('wechat-adapter', {}).then(function () { setAdMsg('已重启'); if (props.onSaved) props.onSaved() }, function (e) { setAdMsg('重启失败：' + (e.message || e)) })
      }
      function save() {
        var c = String(context).trim() === '' ? null : Number(context), b = String(buffer).trim() === '' ? null : Number(buffer)
        if (c !== null && !(Number.isInteger(c) && c >= 1 && c <= 20)) { setMsg('请填 1–20 的整数，留空恢复默认 8'); return }
        if (b !== null && !(b >= 0 && b <= 30)) { setMsg('请填 0–30 秒，留空恢复默认 3'); return }
        post('wechat', { contextMessages: c, bufferSeconds: b }).then(function () {
          setMsg('已保存。适配器下次轮询时同步，当前这一批沿用原值。')
          if (c === null) setContext('8'); if (b === null) setBuffer('3')
          if (props.onSaved) props.onSaved()
        }, function (e) { setMsg('保存失败：' + (e.message || e)) })
      }
      return h(Card, { title: '微信', delay: 300 },
        h('div', null, h('span', { className: 'dw-big ' + (contacted && !offline ? 'dw-ok' : 'dw-bad') }, stateText)),
        KV([
          ['最近联系', w.lastContactAt ? local(w.lastContactAt, zone) : '—'],
          ['绑定账号', w.accountId || '—'],
          ad ? ['适配器', ad.running ? '由插件管理 · 运行中' + (ad.restarts ? '（已重启 ' + ad.restarts + ' 次）' : '') : '由插件管理 · 已退出' + (ad.error ? '：' + ad.error : ad.lastExit ? '（' + ad.lastExit + '），等待重启' : '')] : null,
          ['聊天', w.accountId ? w.chats + ' 个' : '—'],
          ['待发送', String(w.pending)],
          ['待核对', h('span', { className: w.uncertain ? 'dw-bad' : '' }, String(w.uncertain))],
        ]),
        w.uncertain ? h('div', { className: 'dw-muted' }, '发送结果不明的消息不会自动重发，请在微信里核对后用适配器 acknowledge 确认。') : null,
        blocked ? h('div', { className: 'dw-bad' }, '上次有消息处理到一半、结果不明。先在微信里核对是否真的发出，再用适配器的 acknowledge 确认（见适配器 README），然后点下面的重启。') : null,
        ad ? h('div', { className: 'dw-bar' }, h('button', { className: 'dw-btn', onClick: restartAdapter }, '重启适配器'), adMsg ? h('span', { className: adMsg.indexOf('失败') >= 0 ? 'dw-bad' : 'dw-muted' }, adMsg) : null) : null,
        h('div', { className: 'dw-setting' },
          h('input', { type: 'text', inputMode: 'numeric', 'aria-label': '群聊读取上文条数', placeholder: '上文条数，默认 8', value: context, onChange: function (e) { setContext(e.target.value); setMsg('') } }),
          h('input', { type: 'text', inputMode: 'decimal', 'aria-label': '图片缓冲秒数', placeholder: '缓冲秒数，默认 3', value: buffer, onChange: function (e) { setBuffer(e.target.value); setMsg('') } }),
          h('button', { className: 'dw-btn', onClick: save }, '保存')),
        h('div', { className: 'dw-muted' }, '上文按消息条数算（群聊被 @ 时带上之前几条）；缓冲是私聊图片等待后续图片或文字的秒数。与共享记忆的 200 轮无关。'),
        msg ? h('div', { className: msg.indexOf('失败') >= 0 || msg.indexOf('请填') >= 0 ? 'dw-bad' : 'dw-muted' }, msg) : null)
    }
    /** QQ：她自己那条 OneBot 通道（原生），以及 SnowLuma 控制台的入口。 */
    function Qq(props) {
      var busyState = useState(false), busy = busyState[0], setBusy = busyState[1]
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      // 两个控制台都带 X-Frame-Options: DENY，塞不进 iframe，所以交给系统浏览器开。
      // 地址和令牌由宿主半侧现给（/dsh-world/qq/console），所以打开就是登录态。
      function openDoor(kind) {
        var label = 'SnowLuma'
        setBusy(true); setMsg('')
        qqGet('console').then(function (res) {
          var door = res && res[kind]
          // 还差密码的门也带着地址，先认这件事，别把登录页当成品打开。
          if (door && door.needs === 'password') { if (props.onNeedPassword) props.onNeedPassword(kind); return null }
          if (door && door.url) {
            return qqPost('open', { kind: kind }).then(function (r) {
              setMsg(r && r.opened ? '已在浏览器打开 ' + label + ' 控制台' : '失败：' + ((r && r.error) || '打不开'))
            })
          }
          setMsg('失败：' + ((door && door.error) || '宿主没给地址'))
          return null
        }, function (e) { setMsg('失败：' + ((e && e.message) || e)) }).then(function () { setBusy(false) })
      }
      // 阳台：拨端口就是开关（0 是关）。
      function flipBridge(port) {
        setBusy(true); setMsg('')
        qqPost('native', { bridge: { port: port } }).then(function () {
          setMsg('')
          if (props.onSaved) props.onSaved()
        }, function (e) { setMsg('失败：' + ((e && e.message) || e)) }).then(function () { setBusy(false) })
      }
      function flipNative(autoReply) {
        setBusy(true); setMsg('')
        qqPost('native', { autoReply: autoReply }).then(function () {
          setMsg('')
          if (props.onSaved) props.onSaved()
        }, function (e) { setMsg('失败：' + ((e && e.message) || e)) }).then(function () { setBusy(false) })
      }
      function copyLine(text) {
        if (!text) { setMsg('这条命令还没生出来'); return }
        if (!navigator.clipboard) { setMsg('这个浏览器不给复制，自己选上面那行'); return }
        navigator.clipboard.writeText(text).then(function () { setMsg('命令已复制') }, function () { setMsg('复制失败，自己选上面那行') })
      }
      return h(Card, { title: 'QQ', delay: 240 }, [
        props.native ? (function (n) {
          if (!n) return h('div', { key: 'n', className: 'dw-muted' }, '她自己的通道：没开')
          return h('div', { key: 'n' }, [
            h('span', { key: 'a', className: n.connected ? 'dw-ok' : 'dw-muted' }, n.connected ? '● 她自己连着 ' + n.url : '● 她自己的通道没连上'),
            h('span', { key: 'b', className: 'dw-muted' }, ' · 收 ' + (n.conversations || 0) + ' 个会话 · 发 ' + (n.sent || 0) + ' 条' + (n.failed ? ' · 失败 ' + n.failed : '') + (n.blocked ? ' · 挡下 ' + n.blocked : '') + (n.autoReply ? ' · 会自己回' : ' · 只看不回')),
            n.lastError ? h('span', { key: 'c', className: 'dw-bad' }, ' · ' + n.lastError) : null,
          ])
        })(props.native) : h('div', { key: 'n', className: 'dw-muted' }, '她自己的通道：没开（配置里 qqNative.enabled）'),
        (function (n) {
          if (!n) return null
          return h('label', { key: 'nt', className: 'dw-setting', style: { cursor: 'pointer' } }, [
            h('input', { key: 'c', type: 'checkbox', checked: n.autoReply === true, disabled: busy,
              onChange: function (e) { flipNative(e.target.checked) } }),
            h('span', { key: 't' }, n.autoReply === true ? ' 会自己回话' : ' 只看不回'),
          ])
        })(props.native),
        (function (n) {
          if (!n) return null
          var b = n.bridge
          if (!b) return h('div', { key: 'nb', className: 'dw-setting' }, [
            h('span', { key: 's', className: 'dw-muted' }, '阳台：关着（要用就在这儿打开）'),
            h('button', { key: 'b', className: 'dw-btn', disabled: busy, onClick: function () { flipBridge(3210) } }, '开这条线（3210）'),
          ])
          return h('div', { key: 'nb' }, [
            h('div', { key: 'l', className: 'dw-muted' },
              h('span', { className: b.serving ? 'dw-ok' : 'dw-muted' }, b.serving ? '● 阳台开着 ' + (b.url || '') : '● 阳台关着'),
              ' · ' + ((b.lines || 0) ? '连着 ' + b.lines + ' 条线' : '还没人敲门')
                + ' · 收了 ' + (b.received || 0) + ' 句、回了 ' + (b.relayed || 0) + ' 句、她开口 ' + (b.spoken || 0) + ' 次'),
            b.lastError ? h('div', { key: 'e', className: 'dw-bad' }, ' · ' + b.lastError) : null,
            h('div', { key: 'c', className: 'dw-muted', style: { wordBreak: 'break-all', fontSize: 12 } }, b.line || ''),
            h('div', { key: 'y', className: 'dw-setting' }, [
              h('button', { key: 'c', className: 'dw-btn', disabled: busy, onClick: function () { copyLine(b.line) } }, '复制这条命令'),
              h('button', { key: 'x', className: 'dw-btn', disabled: busy, onClick: function () { flipBridge(0) } }, '关掉这条线'),
            ]),
          ])
        })(props.native),
        h('div', { key: 'k', className: 'dw-setting' },
          h('button', { className: 'dw-btn', disabled: busy, onClick: function () { openDoor('snowluma') } }, '打开 SnowLuma 控制台')),
        h('div', { key: 'b', className: 'dw-setting' },
          h('button', { className: 'dw-btn', disabled: busy, onClick: function () { if (props.onSaved) props.onSaved() } }, '刷新')),
        msg ? h('div', { key: 'x', className: msg.indexOf('失败') >= 0 ? 'dw-bad' : 'dw-muted' }, msg) : null,
      ])
    }
    /**
     * 第一次打开 SnowLuma 控制台时，得先用面板密码换一个会话令牌：那令牌只活在那边的进程内存里，重启就没了。
     * 密码不在浏览器里存着，填完就交给宿主半侧，换到令牌后由宿主把系统浏览器拉起来。
     * 两个控制台都发 X-Frame-Options: DENY，塞不进 iframe，所以只能这样开。
     */
    function Panel(props) {
      var passState = useState(''), pass = passState[0], setPass = passState[1]
      var busyState = useState(false), busy = busyState[0], setBusy = busyState[1]
      var errState = useState(''), err = errState[0], setErr = errState[1]
      function signIn() {
        if (!pass) { setErr('先填密码'); return }
        setBusy(true); setErr('')
        qqPost('panel-password', { password: pass }).then(function (body) {
          var next = body && body.snowluma
          if (!next || !next.url) { setErr((next && next.error) || '登录失败'); return null }
          setPass('')
          return qqPost('open', { kind: 'snowluma' }).then(function (r) {
            if (r && r.opened) { if (props.onClose) props.onClose() } else setErr((r && r.error) || '打不开浏览器')
          })
        }, function (e) { setErr(String((e && e.message) || e)) }).then(function () { setBusy(false) })
      }
      return h('div', { style: { position: 'fixed', left: 0, top: 0, width: '100%', height: '100%', zIndex: 60, background: 'rgba(10,14,20,.66)', display: 'flex', alignItems: 'center', justifyContent: 'center' } },
        h('div', { style: { width: 480, maxWidth: '92%', background: '#141b25', border: '1px solid rgba(255,255,255,.1)', borderRadius: 12, padding: 20, boxSizing: 'border-box' } },
          h('h3', { style: { margin: '0 0 8px', color: '#e8edf4' } }, '第一次打开 SnowLuma 控制台'),
          h('div', { className: 'dw-muted', style: { marginBottom: 16, lineHeight: 1.6 } }, '它只认密码、没有账号名这回事；会话令牌只存在进程内存里，过期就没了，所以要用面板密码换一次。密码留在你这台机器上，不会回传浏览器。'),
          h('label', { style: { display: 'block', marginBottom: 16, color: '#c7d2de' } }, '密码 ',
            h('input', { type: 'password', value: pass, onChange: function (e) { setPass(e.target.value) }, onKeyDown: function (e) { if (e.key === 'Enter') signIn() }, style: { width: 220 } })),
          err ? h('div', { className: 'dw-bad', style: { marginBottom: 12 } }, '● ' + err) : null,
          h('button', { className: 'dw-btn', disabled: busy, onClick: signIn }, busy ? '……' : '登录并打开'),
          h('button', { className: 'dw-btn', style: { marginLeft: 10 }, onClick: function () { if (props.onClose) props.onClose() } }, '取消')))
    }
    /** 接入：微信和 QQ 各一个开关。开着才注册微信的发送工具、路由和适配器 / 才由插件管理 QQ 桥；关掉就撤掉，立即生效，状态记在 world.json。 */
    function Modules(props) {
      var m = props.modules
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      var busyState = useState(''), busy = busyState[0], setBusy = busyState[1]
      function flip(name, value) {
        var body = {}; body[name] = value
        setBusy(name); setMsg('')
        post('modules', body).then(function () { setBusy(''); if (props.onSaved) props.onSaved() }, function (e) { setBusy(''); setMsg('切换失败：' + (e.message || e)) })
      }
      function row(name, label, info, onText, offText) {
        var state = !info.available ? '未配置' : !info.enabled ? '已关闭' : info.running ? '运行中' : props.running ? '启动中' : '已开启，世界启动后生效'
        return h('div', { key: name, className: 'dw-setting' },
          h('span', null, h('b', null, label), h('span', { className: 'dw-muted' }, ' · ' + state)),
          h('button', { className: 'dw-btn', disabled: !info.available || busy === name, onClick: function () { flip(name, !info.enabled) } }, info.enabled ? '关闭' : '开启'),
          h('div', { className: 'dw-muted', style: { flexBasis: '100%' } }, info.enabled ? onText : offText))
      }
      return h(Card, { title: '接入', delay: 270 },
        row('wechat', '微信', m.wechat, '已注册 wechat_chats、wechat_history、wechat_send、wechat_delivery，可先看群聊再发言，并随之启动适配器。关闭会撤掉它们并停掉适配器。', '工具未注册，适配器已停。开启后立即注册，无需重启。'),
        row('qq', 'QQ', m.qq, '插件自己直连 OneBot：状态和两个开关在 QQ 那张卡上。关闭就断开这条通道。', '插件不跑 QQ 通道，QQ 卡隐藏。开启后立即恢复。'),
        m.bili ? row('bili', '刷B站', m.bili, '每天到点取料、写日报，再用阳台叫醒她；私信每 2 分钟看一眼。关掉就是这三个定时器一起撤掉。', '定时器和私信轮询都撤了；「B站」那页还能手动跑一轮。') : null,
        msg ? h('div', { className: 'dw-bad' }, msg) : null)
    }

    /** 搬家：把家挪到一条已有的会话上（别人的鱼想接上自己原来的对话，就用这个）。 */
    function HomePicker(props) {
      var listState = useState(null), list = listState[0], setList = listState[1]
      var pickState = useState(''), pick = pickState[0], setPick = pickState[1]
      var noteState = useState(''), note = noteState[0], setNote = noteState[1]
      function load() {
        setNote('正在找会话……')
        api('sessions').then(function (r) { setList((r && r.sessions) || []); setNote('') }).catch(function (e) { setNote(String(e && e.message || e)) })
      }
      function adopt() {
        if (!pick) return
        setNote('正在搬家……')
        post('home', { sessionId: pick }).then(function () {
          setNote('换好了，她会在这条会话里醒来')
          if (props.refresh) props.refresh()
        }).catch(function (e) { setNote(String(e && e.message || e)) })
      }
      return h('div', { style: { marginTop: 8 } },
        h('span', { className: 'dw-muted' }, '搬家：把家挪到一条已有的会话 '),
        h('button', { className: 'dw-btn', onClick: load }, list ? '重新找' : '找会话'),
        list ? h('div', { style: { marginTop: 6 } },
          h('select', {
            value: pick,
            onChange: function (e) { setPick(e.target.value) },
            style: {
              maxWidth: 460, padding: '4px 8px', borderRadius: 6,
              background: '#2a2f3a', color: '#f2f3f5',
              border: '1px solid rgba(127,127,127,.45)', fontSize: 13,
            },
          },
            h('option', { value: '', style: { background: '#2a2f3a', color: '#f2f3f5' } }, '— 选一条会话 —'),
            list.map(function (s) {
              var t = (s.title || '没标题') + '　' + String(s.id).replace(/^session-/, '').slice(0, 8)
              return h('option', { key: s.id, value: s.id, style: { background: '#2a2f3a', color: '#f2f3f5' } }, t)
            })),
          h('button', { className: 'dw-btn', style: { marginLeft: 8 }, disabled: !pick, onClick: adopt }, '设成家')) : null,
        note ? h('div', { className: 'dw-muted', style: { marginTop: 4 } }, note) : null)
    }
    function Overview(props) {
      var snap = props.snap, zone = snap.timeZone, life = snap.life, alarm = life && life.alarm, mem = snap.memory
      var health = list(snap.health), wakes = life ? list(life.recentWakes) : []
      var todayKey = new Date().toLocaleDateString('sv-SE', { timeZone: zone })
      var diaryDone = list(snap.diaryDates).indexOf(todayKey) >= 0
      var spent = snap.budget && snap.budget.today && snap.budget.today.day === todayKey ? snap.budget.today.yuan : 0
      var daily = snap.budget ? snap.budget.daily : null
      var left = daily === null || daily === undefined ? null : Math.max(0, daily - (spent || 0))
      var welcome = !snap.running && !life
      return h('div', { className: 'dw-pane' },
        welcome ? h(Card, null, h('div', { className: 'dw-welcome' },
          h('h3', null, '她还没有住进来'),
          h('div', { className: 'dw-muted' }, '先写下她是谁，再按右上角的「开始」。'),
          h('ol', { className: 'dw-steps' },
            h('li', null, '在「人设」里写她的名字、性格和你对她的愿景'),
            h('li', null, '需要的话，在「家的说明书」里写你想对她说的话'),
            h('li', null, '按「开始」：插件建好她的房间和家，叫醒她')),
          h('div', { className: 'dw-muted', style: { marginTop: 10 } }, '不想新开一条会话？先在这里挑一条已有的当家，再按「开始」。'),
          h(DrivePicker, { running: snap.running }),
          h(HomePicker, { refresh: props.refresh }))) : null,
        life ? h('div', { className: 'dw-grid' },
          h(Card, { title: '家', delay: 0 },
            h('div', { className: 'dw-big' }, statusLabel[life.status] || life.status),
            alarm
              ? h('div', { style: { marginTop: 8 } },
                  h('span', { className: 'dw-muted' }, (sourceLabel[alarm.source] || '闹钟') + ' · '),
                  local(alarm.at, zone),
                  h('span', { className: 'dw-muted' }, '（还有 ' + remaining(alarm.at) + '）'))
              : h('div', { className: 'dw-muted', style: { marginTop: 8 } }, '没有待定的闹钟'),
            alarm && alarm.note ? h('blockquote', { className: 'dw-quote' }, alarm.note) : null,
            h('div', { style: { marginTop: 10 } }, KV([
              ['会话路径', h('span', { title: String(snap.roomDir || '') }, String(snap.roomDir || '（没拿到路径）').replace(/^.*worlds\\/, '~/.dsh/worlds\\'))],
              ['日记', diaryDone ? '今天写了' : h('span', { className: 'dw-muted' }, '今天还没写')],
              ['下次回顾', life.review ? local(life.review.at, zone) : '—'],
              ['最近', wakes.length ? h('div', { className: 'dw-trail' }, wakes.map(function (w, i) { return h('span', { key: i }, local(w.deliveredAt, zone) + ' ' + (sourceLabel[w.source] || w.source) + (w.lateMs >= 120000 ? ' · 晚 ' + Math.round(w.lateMs / 60000) + ' 分' : '')) })) : '—'],
            ])),
            h(ScheduleCard, { schedule: snap.schedule, onSaved: props.refresh }),
            h('div', { style: { marginTop: 10 } },
              h('button', { className: 'dw-btn', onClick: function () { post('wake', {}).then(function () { props.refresh && props.refresh() }) } }, '现在叫醒'),
              h(HomePicker, { refresh: props.refresh })),
            h(DrivePicker, { running: snap.running })),
        ) : null,
        h('div', { className: 'dw-grid' },
          h(Card, { title: '健康', delay: 120 }, health.length ? health.map(function (f, i) { return h('div', { key: i, className: 'dw-bad' }, '● ' + f) }) : h('div', { className: 'dw-ok' }, '● 一切正常')),
          h(Memory, { mem: mem, onSaved: props.refresh }),
          h(Budget, { budget: snap.budget, onSaved: props.refresh }),
          snap.modules && (snap.modules.wechat.available || snap.modules.qq.available || (snap.modules.bili && snap.modules.bili.available)) ? h(Modules, { modules: snap.modules, running: snap.running, onSaved: props.refresh }) : null,
          snap.wechat ? h(Wechat, { wechat: snap.wechat, zone: zone, onSaved: props.refresh }) : null,
          snap.native ? h(Qq, { native: snap.native, onSaved: props.refresh, onNeedPassword: props.onNeedPassword }) : null))
    }
    /** 作息卡片：三个时间，存在房间的 作息.json，插件每分钟读。 */
    function ScheduleCard(props) {
      var sc = props.schedule || {}
      var st = useState(function () { return { wake: sc.wake || '', diary: sc.diary || '', review: sc.review || '' } }), form = st[0], setForm = st[1]
      var msgSt = useState(''), msg = msgSt[0], setMsg = msgSt[1]
      function edit(key) { return function (e) { var v = e.target.value; setForm({ wake: form.wake, diary: form.diary, review: form.review, [key]: v }) } }
      function save() {
        post('schedule', { wake: form.wake, diary: form.diary, review: form.review }).then(function () {
          setMsg('已保存，下一分钟生效')
          props.onSaved && props.onSaved()
        }, function (e) { setMsg('没保存上：' + ((e && e.message) || e)) })
      }
      return h('div', { style: { marginTop: 10 } },
        h('div', { className: 'dw-muted' }, '作息（HH:MM，改完下一分钟生效）'),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' } },
          h('label', null, '早上醒 ', h('input', { value: form.wake, onChange: edit('wake'), placeholder: '08:55', style: { width: 64 } })),
          h('label', null, '日记 ', h('input', { value: form.diary, onChange: edit('diary'), placeholder: '22:35', style: { width: 64 } })),
          h('label', null, '回顾 ', h('input', { value: form.review, onChange: edit('review'), placeholder: '23:00', style: { width: 64 } }))),
        h('button', { className: 'dw-btn', style: { marginTop: 6 }, onClick: save }, '保存作息'),
        msg ? h('span', { className: 'dw-muted', style: { marginLeft: 8 } }, msg) : null)
    }
    /** 备份：只拷白名单，恢复时不删东西。 */
    function Backup() {
      var st = useState(null), info = st[0], setInfo = st[1]
      var msgSt = useState(''), msg = msgSt[0], setMsg = msgSt[1]
      var busySt = useState(false), busy = busySt[0], setBusy = busySt[1]
      var dirSt = useState(''), dir = dirSt[0], setDir = dirSt[1]
      var outSt = useState(''), outDir = outSt[0], setOutDir = outSt[1]
      var driveSt = useState(''), drive = driveSt[0], setDrive = driveSt[1]
      var drivesSt = useState(null), drives = drivesSt[0], setDrives = drivesSt[1]
      useEffect(function () { api('drives').then(function (r) { setDrives(r.drives || []) }, function () { setDrives([]) }) }, [])
      function load() {
        api('backup').then(function (r) {
          setInfo(r)
          if (r && r.savedDir) setDir(r.savedDir)
        }, function (e) { setMsg('读取失败：' + (e.message || e)) })
      }
      function inspect() {
        setBusy(true); setMsg('')
        fetch('/dsh-world/console/restore?dir=' + encodeURIComponent(dir), { cache: 'no-store' })
          .then(function (r) { return r.json() }).then(function (r) {
            if (!r || r.ok === false) setMsg('看不了：' + ((r && r.error) || '目录不对'))
            else setMsg('里面有 ' + (r.items || []).length + ' 项、约 ' + r.mb + ' MB：' + (r.items || []).join('、'))
          }, function (e) { setMsg('看不了：' + (e.message || e)) }).then(function () { setBusy(false) })
      }
      function restore(dry) {
        if (!dry && !window.confirm('会把这些东西拷回原位（覆盖现有文件，但不删除）。确定吗？')) return
        setBusy(true); setMsg(dry ? '预演中…' : '正在恢复…')
        post('restore', { dir: dir, dry: !!dry, drive: drive || undefined }).then(function (r) {
          if (r && r.ok === false) { setMsg('不行：' + (r.error || '')); return }
          setMsg(dry
            ? ('预演：会写 ' + (r.plan || []).length + ' 项' + (r.drive ? '，恢复到 ' + r.drive + ' 盘' : ''))
            : ('已恢复 ' + (r.written || []).length + ' 项' + (r.restartRequired ? '；重启 DSH 后在新位置醒来' : '')))
        }, function (e) { setMsg('失败：' + (e.message || e)) }).then(function () { setBusy(false) })
      }
      useEffect(load, [])
      function run(dry) {
        setBusy(true); setMsg(dry ? '正在预演…' : '正在拷…')
        post('backup', { dry: !!dry }).then(function (r) {
          setOutDir(r.dir || '')
          setMsg((dry ? '预演：会拷 ' : '备份完了：') + (r.items || (r.copied || []).length) + ' 项')
          load()
        }, function (e) { setMsg('失败：' + (e.message || e)) }).then(function () { setBusy(false) })
      }
      return h(Card, { title: '备份' },
        info ? h('div', null,
          h('div', { className: 'dw-muted' }, '房间约 ' + info.roomMB + ' MB · 上一次备份：' + (info.last || '还没有过')),
          h('div', { className: 'dw-muted' }, '会拷：房间（日记/记忆/规矩/B站登录）、人格、家的说明书、生活线、profile 配置。'),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' } },
            h('button', { className: 'dw-btn primary', style: { minWidth: 96, padding: '6px 14px' }, disabled: busy, onClick: function () { run(false) } }, busy ? '……' : '备份一次'),
            h('button', { className: 'dw-btn', disabled: busy, onClick: function () { run(true) } }, '只看会拷什么')),
          h('div', { className: 'dw-muted', style: { marginTop: 14 } }, '备份放在哪儿（留空就用默认位置：' + ((info && info.defaultRoot) || 'DSH 目录下的 backups') + '）。换电脑时也把备份文件夹路径填这儿。'),
          h('input', { type: 'text', placeholder: (info && info.defaultRoot) || '留空 = 默认位置', value: dir, style: { width: '100%', maxWidth: 520, padding: '4px 8px', borderRadius: 6, background: '#2a2f3a', color: '#f2f3f5', border: '1px solid rgba(127,127,127,.45)' }, onChange: function (e) { setDir(e.target.value) } }),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' } },
            h('button', { className: 'dw-btn', disabled: busy, onClick: function () { inspect() } }, '看看有什么'),
            h('button', { className: 'dw-btn', disabled: busy, onClick: function () { restore(true) } }, '预演恢复'),
            h('button', { className: 'dw-btn primary', disabled: busy, onClick: function () { restore(false) } }, '真的恢复')),
          h('div', { className: 'dw-muted', style: { marginTop: 12, wordBreak: 'break-all' } }, '家现在在：' + ((info && info.worldDir) || '—')),
          h('div', { className: 'dw-muted' }, '恢复目标默认写回现在的位置；换电脑或第一次用插件时，可以先点一块盘，恢复到那块盘的 dsh-world\\worlds。'),
          drives === null ? h('div', { className: 'dw-muted' }, '正在扫盘……')
            : h('div', { className: 'dw-setting' }, drives.map(function (d) {
              return h('button', { key: d.letter, className: 'dw-btn' + (drive === d.letter ? ' primary' : ''), disabled: busy, onClick: function () { setDrive(drive === d.letter ? '' : d.letter) } }, d.letter + ' 盘')
            })),
          drive ? h('div', { className: 'dw-muted' }, '会恢复到 ' + drive + ':\\dsh-world\\worlds，恢复完重启生效') : null) : h('div', { className: 'dw-muted' }, msg || '读取中…'),
        outDir ? h('div', { style: { marginTop: 10 } },
          h('div', { className: 'dw-muted' }, '备份在这个文件夹里：'),
          h('code', { style: { display: 'block', marginTop: 4, padding: '6px 8px', borderRadius: 6, background: '#20242c', wordBreak: 'break-all' } }, outDir),
          h('button', { className: 'dw-btn', style: { marginTop: 6 }, onClick: function () {
            try { navigator.clipboard.writeText(outDir); setMsg('路径已复制') } catch { setMsg('复制不了，手动选一下吧') }
          } }, '复制路径'),
          h('div', { className: 'dw-muted', style: { marginTop: 6 } }, '这个文件夹整个拷走就行（想放夸克也可以）；换电脑时把它填进上面的框，再点恢复。')) : null,
        msg ? h('div', { className: 'dw-muted', style: { marginTop: 8 } }, msg) : null)
    }

    function Records(props) {
      var snap = props.snap, zone = snap.timeZone, life = snap.life, compactions = list(snap.compactions)
      return h('div', { className: 'dw-pane' },
        h(Backup),
        h(Activity, { days: list(snap.activityDays), zone: zone, tick: props.tick }),
        h(Diary, { dates: list(snap.diaryDates) }),
        h(Card, { title: '压缩' }, compactions.length ? h('table', null, h('tbody', null, compactions.map(function (c, i) {
          return h('tr', { key: i }, h('td', { className: 'dw-muted' }, local(c.time, zone)), h('td', null, life && c.sessionId === life.homeSessionId ? '家' : String(c.sessionId || '').slice(-8)), h('td', { className: c.ok ? 'dw-ok' : 'dw-bad' }, c.ok ? '成功' : '失败：' + (c.error || '')), h('td', { className: 'dw-muted' }, c.shadowedTokens ? '缩掉约 ' + c.shadowedTokens + ' token' : ''))
        }))) : h('div', { className: 'dw-muted' }, '还没有压缩记录')))
    }

    /**
     * 刷B站那间屋子（`/dsh-world/bili/*`）：登录、设置、现在跑一轮、看日报、私信。
     * 收料、写日报、叫醒都在宿主半侧（bili/index.js），这儿只摆按钮和状态。
     */
    function biliGet(path) { return fetch('/dsh-world/bili/' + path, { cache: 'no-store' }).then(settle) }
    function biliPost(path, body) {
      return fetch('/dsh-world/bili/' + path, { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json', 'x-dsh-world': '1' }, body: JSON.stringify(body || {}) }).then(settle)
    }
    /** QQ 设置：主人 QQ 直接进白名单、群里多久没人说话就收这一轮。 */
    function QqPage() {
      var st = useState(null), cfg = st[0], setCfg = st[1]
      var msgSt = useState(''), msg = msgSt[0], setMsg = msgSt[1]
      var busySt = useState(false), busy = busySt[0], setBusy = busySt[1]
      var flashSt = useState(''), flash = flashSt[0], setFlash = flashSt[1]
      var defaultKeywords = ''
      function load() {
        api('qq').then(function (r) { setCfg({ ownerQQ: r.ownerQQ || '', silenceMinutes: r.silenceMinutes || 5, wakeGapSeconds: r.wakeGapSeconds || 20, allowGroups: (r.allowGroups || []).join(', '), groupKeywords: (Array.isArray(r.groupKeywords) && r.groupKeywords.length ? r.groupKeywords : defaultKeywords.split(' / ')).join(' / '), enabled: !!r.enabled, splitDm: r.splitDm !== false,
          windows: Array.isArray(r.windows) && r.windows.length ? r.windows : [{ start: '12:00', end: '14:00', times: 1 }],
          minGapMinutes: r.minGapMinutes ?? 10 }) },
          function (e) { setMsg('读取失败：' + (e.message || e)) })
      }
      useEffect(load, [])
      if (!cfg) return h('div', { className: 'dw-muted' }, msg || '读取中…')
      function setWin(index, patch) {
        var next = (cfg.windows || []).slice()
        next[index] = Object.assign({}, next[index] || {}, patch)
        setCfg(Object.assign({}, cfg, { windows: next }))
      }
      function save() {
        setBusy(true); setMsg('')
        post('qq', {
          ownerQQ: String(cfg.ownerQQ || ''),
          silenceMinutes: Number(cfg.silenceMinutes) || 5,
          wakeGapSeconds: Number(cfg.wakeGapSeconds) || 20,
          allowGroups: String(cfg.allowGroups || '').split(/[,，\s]+/).filter(Boolean),
          groupKeywords: String(cfg.groupKeywords || '').split(/[,，/、\s]+/).filter(Boolean),
          splitDm: cfg.splitDm !== false,
          windows: (cfg.windows || []).filter(function (w) { return w && w.start && w.end }),
          minGapMinutes: Number(cfg.minGapMinutes) || 10,
        }).then(function (r) {
          setCfg({ ownerQQ: r.ownerQQ || '', silenceMinutes: r.silenceMinutes || 5, wakeGapSeconds: r.wakeGapSeconds || 20, allowGroups: (r.allowGroups || []).join(', '), groupKeywords: (Array.isArray(r.groupKeywords) && r.groupKeywords.length ? r.groupKeywords : defaultKeywords.split(' / ')).join(' / '), enabled: !!r.enabled, splitDm: r.splitDm !== false,
          windows: Array.isArray(r.windows) && r.windows.length ? r.windows : [{ start: '12:00', end: '14:00', times: 1 }],
          minGapMinutes: r.minGapMinutes ?? 10 })
          setMsg('已保存。主人 QQ 已进私聊白名单。')
          setFlash('✓ 已保存')
          setTimeout(function () { setFlash('') }, 2500)
        }, function (e) { setMsg('保存失败：' + (e.message || e)) }).then(function () { setBusy(false) })
      }
      var field = { padding: '4px 8px', borderRadius: 6, background: '#2a2f3a', color: '#f2f3f5', border: '1px solid rgba(127,127,127,.45)', fontSize: 13 }
      return h('div', { className: 'dw-pane' },
        h(Card, { title: '主人QQ号' },
          h('div', { className: 'dw-muted', style: { marginBottom: 6 } }, '填了就一直在这个号的私聊白名单里，不用再改配置。'),
          h('input', { type: 'text', inputMode: 'numeric', placeholder: '比如 100000001', value: cfg.ownerQQ, style: Object.assign({ width: 200 }, field), onChange: function (e) { setCfg(Object.assign({}, cfg, { ownerQQ: e.target.value })) } })),
        h(Card, { title: '作息（醒来找你的时间）' },
          h('div', { className: 'dw-muted' }, '在时间段里随机挑时候醒来，主动找你说话。可以加好几档。'),
          (cfg.windows || []).map(function (win, index) {
            return h('div', { key: index, style: { display: 'flex', gap: 6, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' } },
              h('input', { type: 'text', value: win.start, placeholder: '12:00', style: Object.assign({ width: 72 }, field), onChange: function (e) { setWin(index, { start: e.target.value }) } }),
              h('span', { className: 'dw-muted' }, '–'),
              h('input', { type: 'text', value: win.end, placeholder: '14:00', style: Object.assign({ width: 72 }, field), onChange: function (e) { setWin(index, { end: e.target.value }) } }),
              h('span', { className: 'dw-muted' }, '醒来'),
              h('input', { type: 'number', min: 1, max: 20, value: win.times, style: Object.assign({ width: 64 }, field), onChange: function (e) { setWin(index, { times: Number(e.target.value) || 1 }) } }),
              h('span', { className: 'dw-muted' }, '次'),
              h('button', { className: 'dw-btn', onClick: function () { setCfg(Object.assign({}, cfg, { windows: (cfg.windows || []).filter(function (_, i) { return i !== index }) })) } }, '删除'))
          }),
          h('button', { className: 'dw-btn', style: { marginTop: 8 }, onClick: function () { setCfg(Object.assign({}, cfg, { windows: (cfg.windows || []).concat([{ start: '12:00', end: '14:00', times: 1 }]) })) } }, '+ 添加窗口'),
          h('div', { style: { marginTop: 12 } }, h('span', { className: 'dw-muted' }, '最小唤醒间隔（分钟，默认 10）')),
          h('input', { type: 'number', min: 0, max: 240, value: cfg.minGapMinutes, style: Object.assign({ width: 90 }, field), onChange: function (e) { setCfg(Object.assign({}, cfg, { minGapMinutes: Number(e.target.value) })) } })),
        h(Card, { title: '群里怎么聊' },
          h('div', { className: 'dw-muted' }, '我说完话后，这一轮陪多久（分钟，默认 5）'),
          h('input', { type: 'number', min: 1, max: 120, value: cfg.silenceMinutes, style: Object.assign({ width: 90 }, field), onChange: function (e) { setCfg(Object.assign({}, cfg, { silenceMinutes: Number(e.target.value) || 5 })) } }),
          h('div', { className: 'dw-muted', style: { marginTop: 10 } }, '多久检查一次群里有没有新对话（秒，默认 20）'),
          h('input', { type: 'number', min: 3, max: 300, value: cfg.wakeGapSeconds, style: Object.assign({ width: 90 }, field), onChange: function (e) { setCfg(Object.assign({}, cfg, { wakeGapSeconds: Number(e.target.value) || 20 })) } }),
          h('div', { className: 'dw-muted', style: { marginTop: 10 } }, '群白名单（群号，逗号分隔；空着就只认默认配置里的群）'),
          h('input', { type: 'text', placeholder: '比如 200000002', value: cfg.allowGroups, style: Object.assign({ width: 240 }, field), onChange: function (e) { setCfg(Object.assign({}, cfg, { allowGroups: e.target.value })) } }),
          h('div', { className: 'dw-muted', style: { marginTop: 10 } }, '唤醒关键词（逗号、斜杠或空格分开；群里提到这些词就算在叫你）'),
          h('input', { type: 'text', placeholder: '留空就用她的名字', value: cfg.groupKeywords, style: Object.assign({ width: 280 }, field), onChange: function (e) { setCfg(Object.assign({}, cfg, { groupKeywords: e.target.value })) } })),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, paddingTop: 10, borderTop: '1px solid rgba(127,127,127,.25)' } },
          h('button', { className: 'dw-btn primary', style: { minWidth: 96, padding: '6px 14px' }, disabled: busy, onClick: save }, busy ? '保存中…' : (flash || '保存')),
          h('span', { className: msg.indexOf('失败') >= 0 ? 'dw-bad' : 'dw-muted' }, msg)))
    }

    function Bili() {
      var st = useState(null), status = st[0], setStatus = st[1]
      var form = useState(null), cfg = form[0], setCfg = form[1]
      var loaded = useRef(false)
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      var busyState = useState(''), busy = busyState[0], setBusy = busyState[1]
      var qrState = useState(null), qr = qrState[0], setQr = qrState[1]
      var keyState = useState(''), qrKey = keyState[0], setQrKey = keyState[1]
      var waitState = useState(false), waiting = waitState[0], setWaiting = waitState[1]
      var digState = useState([]), digests = digState[0], setDigests = digState[1]
      var textState = useState(null), text = textState[0], setText = textState[1]
      var uidState = useState(''), imUid = uidState[0], setImUid = uidState[1]
      var msgsState = useState(null), msgs = msgsState[0], setMsgs = msgsState[1]
      var draftState = useState(''), draft = draftState[0], setDraft = draftState[1]
      var imNoteState = useState(''), imNote = imNoteState[0], setImNote = imNoteState[1]
      var splitState = useState(null), split = splitState[0], setSplit = splitState[1]

      function apply(r) {
        if (!r) return
        setStatus(function (prev) { return Object.assign({}, prev || {}, r) })
        if (!loaded.current) {
          loaded.current = true
          setCfg({ dailyTime: r.dailyTime || '21:30', dailyTimes: (r.dailyTimes && r.dailyTimes.length ? r.dailyTimes.slice(0, 3) : [r.dailyTime || '21:30']), keywords: r.keywords || '', ownerUid: r.ownerUid || '', limit: r.limit || 8 })
        }
      }
      function refresh() { return biliGet('status').then(apply, function (e) { setMsg('读取失败：' + (e.message || e)) }) }
      function loadDigests() {
        biliGet('feed/digests').then(function (r) { setDigests(list(r && r.days)) }, function () { /* 没有就没有 */ })
      }
      useEffect(function () { refresh(); loadDigests(); api('qq').then(function (r) { setSplit(r.splitDm !== false) }, function () { setSplit(true) }) }, [])
      useEffect(function () {
        if (!waiting || !qrKey) return
        var alive = true
        var timer = setInterval(function () {
          biliGet('login/status?key=' + encodeURIComponent(qrKey)).then(function (r) {
            if (!alive) return
            if (r.state === 'ok') { setWaiting(false); setQr(null); setQrKey(''); setMsg('登录成功'); refresh() }
            else if (r.state === 'expired' || r.state === 'error') {
              setWaiting(false); setQr(null); setQrKey('')
              setMsg(r.state === 'expired' ? '二维码过期了，重新点一次「扫码登录」' : (r.error || '出错了'))
            }
            else if (r.msg) setMsg(r.msg)
          }, function () { /* 下一轮再试 */ })
        }, 2000)
        return function () { alive = false; clearInterval(timer) }
      }, [waiting, qrKey])

      var flashState = useState(''), flash = flashState[0], setFlash = flashState[1]
      function normTime(v) {
        var text = String(v || '').trim().replace('：', ':')
        var m = /^(\d{1,2}):(\d{1,2})$/.exec(text)
        if (!m) return text
        var h = Number(m[1]), mi = Number(m[2])
        if (!(h >= 0 && h <= 23 && mi >= 0 && mi <= 59)) return text
        return (h < 10 ? '0' : '') + h + ':' + (mi < 10 ? '0' : '') + mi
      }
      function save() {
        if (!cfg) return
        setBusy('save'); setMsg('')
        biliPost('cfg', Object.assign({}, cfg, { dailyTimes: (cfg.dailyTimes || []).map(normTime).filter(Boolean) })).then(function (r) {
          // 保存的响应里没有登录态，直接 apply 会把“已登录”冲成“未登录”——所以重新查一次状态
          setMsg('已保存：' + ((r.dailyTimes || [r.dailyTime]).filter(Boolean).join(' / ')) + ' 各刷一轮，每轮 ' + (r.limit || 8) + ' 条')
          refresh()
          setFlash('✓ 已保存')
          setTimeout(function () { setFlash('') }, 2500)
        }, function (e) { setMsg('保存失败：' + (e.message || e)) }).then(function () { setBusy('') })
      }
      function run() {
        setBusy('run'); setMsg('正在搜、抓字幕、看几条评论，慢一点……')
        biliPost('feed/run', { keywords: cfg ? cfg.keywords : '' }).then(function (r) {
          refresh()
          loadDigests()
          if (r.ok) setMsg('这轮取到 ' + r.count + ' 条（有字幕 ' + r.with_subtitle + '），日报：' + (r.digest || '没写成')
            + (r.woke && r.woke.ok ? '；阳台已经叫过她' : '；阳台没开，没叫醒'))
          else setMsg('取料没成：' + (r.error || JSON.stringify(r.errors || {})))
        }, function (e) { setMsg('取料没成：' + (e.message || e)) }).then(function () { setBusy('') })
      }
      function toggle() {
        var next = !(status && status.enabled)
        setBusy('toggle'); setMsg('')
        biliPost('enabled', { enabled: next }).then(function (r) {
          apply(r); setMsg(next ? '已开启：定时器和私信轮询都挂上了' : '已关闭：定时器和私信轮询都撤了，B站 这页还能手动跑')
        }, function (e) { setMsg('切换失败：' + (e.message || e)) }).then(function () { setBusy('') })
      }
      function login() {
        setBusy('login'); setMsg('正在要一张码……')
        biliPost('login', {}).then(function (r) {
          if (!r.ok) { setMsg(r.error || '出码失败'); return }
          setQrKey(r.key); setQr(r.png ? 'data:image/png;base64,' + r.png : null); setWaiting(true)
          setMsg(r.png ? '拿手机上的 B站 扫这张码' : '二维码没画出来，点下面那个链接去确认')
        }, function (e) { setMsg('出码失败：' + (e.message || e)) }).then(function () { setBusy('') })
      }
      function logout() {
        if (!window.confirm('要清掉本地登录态吗？下一次用还得重新扫。')) return
        setBusy('logout')
        biliPost('logout', {}).then(function (r) { setMsg(r.msg || '已登出'); setQr(null); setQrKey(''); setWaiting(false); refresh() },
          function (e) { setMsg('登出失败：' + (e.message || e)) }).then(function () { setBusy('') })
      }
      function showDigest(day) {
        biliGet('feed/text?which=report&day=' + encodeURIComponent(day)).then(function (r) {
          setText({ day: day, body: r && r.ok ? (r.text || '') : ((r && r.error) || '还没有') })
        }, function (e) { setText({ day: day, body: '读取失败：' + (e.message || e) }) })
      }
      function readIm() {
        var uid = (imUid || '').trim() || (cfg && cfg.ownerUid) || ''
        if (!uid) { setImNote('先填对方 UID'); return }
        biliGet('im/messages?uid=' + encodeURIComponent(uid)).then(function (r) {
          setMsgs(r && r.ok ? list(r.messages) : [{ text: (r && r.error) || '拉消息失败' }])
          setImNote('')
        }, function (e) { setImNote(String(e.message || e)) })
      }
      function sendIm() {
        var uid = (imUid || '').trim() || (cfg && cfg.ownerUid) || ''
        var body = (draft || '').trim()
        if (!uid || !body) return
        setBusy('im')
        biliPost('im/send', { uid: uid, text: body }).then(function (r) {
          setDraft(''); setImNote(r.ok ? '发出去了' : (r.error || '发送失败'))
          if (r.ok) readIm()
        }, function (e) { setImNote(String(e.message || e)) }).then(function () { setBusy('') })
      }

      if (!status) return h('div', { className: 'dw-pane' }, h(Card, { title: 'B站' }, h('div', { className: 'dw-muted' }, msg || '读取中…')))
      var today = status.today || {}
      var logged = status.logged === true
      var clock = function (ts) {
        if (!ts) return ''
        var n = Number(ts) > 1e12 ? Math.round(Number(ts) / 1e6) : Number(ts)
        return new Date(n * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      }
      return h('div', { className: 'dw-pane' },
        h(Card, { title: '她的B站' },
          h('div', null, logged
            ? h('span', { className: 'dw-ok' }, '● 已登录　' + (status.uname || '（没拿到昵称）') + '　UID ' + (status.mid || '?') + '　Lv' + (status.level ?? '?'))
            : h('span', { className: 'dw-bad' }, '○ 未登录　') , logged ? null : h('span', { className: 'dw-muted' }, status.reason || '')),
          h('div', { style: { marginTop: 6 } }, h('span', { className: status.enabled ? 'dw-ok' : 'dw-muted' },
            status.enabled ? '● 功能开着' : '● 功能关着'),
            h('span', { className: 'dw-muted' }, ' · 世界' + (status.worldRunning ? '开着' : '停着')
              + (status.armed ? ' · 定时器挂着' : ' · 定时器没挂')
              + ' · 今天' + (today.report ? ('刷过（' + local(today.report.at) + '）') : '还没刷')
              + (today.candidates === null || today.candidates === undefined ? '' : ' · 上次 ' + today.candidates + ' 条'))),
          h('div', { className: 'dw-setting' },
            h('button', { className: 'dw-btn primary', disabled: busy !== '', onClick: login }, busy === 'login' ? '……' : '扫码登录'),
            h('button', { className: 'dw-btn', disabled: busy !== '' || !logged, onClick: logout }, '登出'),
            h('span', { className: 'dw-muted' }, status.stateDir || '')),
          msg || qr ? h('div', { style: { marginTop: 8 } }, msg ? h('div', { className: msg.indexOf('失败') >= 0 || msg.indexOf('没成') >= 0 ? 'dw-bad' : 'dw-muted' }, msg) : null,
            qr ? h('img', { src: qr, width: 190, height: 190, alt: '登录二维码', style: { background: '#fff', padding: 8, borderRadius: 8, marginTop: 6 } }) : null) : null),
        cfg ? h(Card, { title: '每天刷什么' },
          h('div', { className: 'dw-setting' },
            h('span', { className: 'dw-muted' }, '每天'),
            (function () {
              var times = cfg.dailyTimes || [cfg.dailyTime || '21:30']
              return h('span', { style: { display: 'inline-flex', gap: 6, flexWrap: 'wrap' } }, [0, 1, 2].map(function (i) {
                return h('input', {
                  key: i, type: 'text', inputMode: 'numeric', placeholder: i === 0 ? '21:30' : '（可不填）',
                  style: { width: 84, padding: '4px 8px', borderRadius: 6, background: '#2a2f3a', color: '#f2f3f5', border: '1px solid rgba(127,127,127,.45)' },
                  value: times[i] || '',
                  onChange: function (e) {
                    var next = times.slice(); next[i] = e.target.value
                    setCfg(Object.assign({}, cfg, { dailyTime: next[0] || '21:30', dailyTimes: next }))
                  }
                })
              }))
            })(),
            h('span', { className: 'dw-muted' }, '主人 UID'),
            h('input', { type: 'text', inputMode: 'numeric', 'aria-label': '主人 UID', value: cfg.ownerUid, onChange: function (e) { setCfg(Object.assign({}, cfg, { ownerUid: e.target.value })) } })),
          h('div', { style: { marginTop: 8 } }, h('span', { className: 'dw-muted' }, '关键词（逗号或顿号隔开，不分先后）')),
          h('textarea', {
            rows: 3, value: cfg.keywords,
            onChange: function (e) { setCfg(Object.assign({}, cfg, { keywords: e.target.value })) },
          }),
          h('div', { style: { marginTop: 8 } }, h('span', { className: 'dw-muted' }, '每轮拉几条（1–30，默认 8）')),
          h('input', {
            type: 'number', min: 1, max: 30, value: cfg.limit || 8,
            style: { width: 90, padding: '4px 8px', borderRadius: 6, background: '#2a2f3a', color: '#f2f3f5', border: '1px solid rgba(127,127,127,.45)' },
            onChange: function (e) { setCfg(Object.assign({}, cfg, { limit: Number(e.target.value) || 8 })) },
          }),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 12, paddingTop: 10, borderTop: '1px solid rgba(127,127,127,.25)' } },
            h('button', { style: { minWidth: 96, padding: '6px 14px' }, className: 'dw-btn primary', disabled: busy !== '', onClick: save }, busy === 'save' ? '保存中…' : (flash || '保存')),
            h('button', { style: { minWidth: 110, padding: '6px 14px' }, className: 'dw-btn', disabled: busy !== '', onClick: run }, busy === 'run' ? '正在刷…' : '现在跑一轮'),
            h('span', { className: 'dw-muted' }, '按一下等于让我现在去 B 站逛一圈，刷完会写日报、再用阳台叫醒我'))) : null,
        h(Card, { title: '最近的日报' },
          digests.length === 0 ? h('div', { className: 'dw-muted' }, '还没有日报')
            : h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } }, digests.slice(0, 7).map(function (d) {
              return h('button', { key: d.day, className: 'dw-btn' + (text && text.day === d.day ? ' primary' : ''), onClick: function () { showDigest(d.day) } }, d.day + '（' + (d.bytes ? Math.round(d.bytes / 100) / 10 + 'KB' : '空') + '）')
            })),
          text ? h('pre', { className: 'dw-preview' }, text.body) : null),
        h(Card, { title: '私信' },
          h('div', { className: 'dw-setting' },
            h('span', { className: 'dw-muted' }, '对方 UID'),
            h('input', { type: 'text', inputMode: 'numeric', value: imUid, placeholder: (cfg && cfg.ownerUid) || '100000001', onChange: function (e) { setImUid(e.target.value) }, onKeyDown: function (e) { if (e.key === 'Enter') readIm() } }),
            h('button', { className: 'dw-btn', disabled: busy !== '', onClick: readIm }, '读对话')),
          msgs === null ? h('div', { className: 'dw-muted', style: { marginTop: 6 } }, '还没读')
            : h('div', { style: { marginTop: 6, maxHeight: 220, overflowY: 'auto', fontSize: 12.5 } },
              msgs.length === 0 ? h('div', { className: 'dw-muted' }, '还没有消息') : msgs.map(function (m, i) {
                return h('div', { key: i }, h('span', { className: 'dw-muted', style: { marginRight: 6 } }, clock(m.ts)),
                  h('span', { style: { fontWeight: m.from_me ? 600 : 400 } }, (m.from_me ? '我：' : '对方：') + m.text))
              })),
          h('div', { style: { marginTop: 8, display: 'flex', gap: 8 } },
            h('textarea', { rows: 2, value: draft, placeholder: '发一条私信……', style: { flex: 1 }, onChange: function (e) { setDraft(e.target.value) } }),
            h('button', { className: 'dw-btn', style: { alignSelf: 'flex-end' }, disabled: busy !== '' || !(draft || '').trim(), onClick: sendIm }, '发送')),
          h('div', { className: 'dw-muted', style: { marginTop: 8 } }, '发出去怎么排：'),
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 } },
            h('input', { type: 'checkbox', checked: split !== false, onChange: function (e) {
              var next = e.target.checked
              setSplit(next)
              post('qq', { splitDm: next }).then(function () { setMsg(next ? '改成一行一条发了' : '改成一整条发了') }, function (err) { setMsg('保存失败：' + (err.message || err)) })
            } }),
            h('span', null, '一行一条发（像人打字；关掉就整条发）')),
          imNote ? h('div', { className: 'dw-muted', style: { marginTop: 6 } }, imNote) : null))
    }


    var num = function (v) { return typeof v === 'number' && isFinite(v) ? String(Math.round(v)) : '—' }
    var pct = function (a, b) { return b > 0 ? Math.round((a / b) * 100) + '%' : '—' }


    /**
     * 聊天页顶上那扇「刷过的视频」：封面 + 跳转 + 我写的两句话。
     * 数据是我用 bili\py\report.py 落下的日报 JSON（`刷B站\<日期>.json`），跟设置页是同一份。
     */
    function BiliWatch() {
      var daysState = useState([]), days = daysState[0], setDays = daysState[1]
      var noteState = useState('正在翻日报……'), note = noteState[0], setNote = noteState[1]
      useEffect(function () {
        var alive = true
        biliGet('feed/history').then(function (r) {
          if (!alive) return
          if (r && r.ok) { setDays(list(r.days)); setNote(list(r.days).length ? '' : '还没有日报') }
          else setNote((r && r.error) || '还没有日报')
        }, function (e) { if (alive) setNote(String((e && e.message) || e)) })
        return function () { alive = false }
      }, [])
      var fmt = function (n) {
        var v = Number(n || 0)
        return v >= 10000 ? (v / 10000).toFixed(1) + ' 万' : String(v)
      }
      var dur = function (s) {
        var t = Number(s || 0), m = Math.floor(t / 60), sec = t % 60
        return m + ':' + String(sec).padStart(2, '0')
      }
      return h('div', { style: { padding: '16px 20px', overflowY: 'auto', height: '100%', boxSizing: 'border-box', fontSize: 13 } },
        h('h3', { style: { margin: '0 0 2px' } }, '刷过的视频'),
        h('div', { style: { opacity: .65, fontSize: 12 } }, '最近 7 天，新的在上面；超过 7 天的候选会自动删掉（日报的 md 留着）。'),
        note ? h('div', { style: { marginTop: 8, opacity: .65, fontSize: 12 } }, note) : null,
        days.map(function (d) {
          return h('div', { key: d.day, style: { marginTop: 18 } },
            h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 } },
              h('b', { style: { fontSize: 14 } }, d.day),
              h('span', { style: { opacity: .65, fontSize: 12 } }, '看了 ' + (d.total || d.count || 0) + ' 条，留下 ' + (d.count || 0) + ' 条'),
              d.warning ? h('span', { style: { fontSize: 12, color: '#d9534f' } }, '⚠ ' + d.warning) : null),
            h('div', { style: { display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))' } },
              list(d.picks).map(function (p) {
                return h('div', { key: d.day + p.bvid, style: { border: '1px solid rgba(127,127,127,.25)', borderRadius: 10, overflow: 'hidden', display: 'flex', flexDirection: 'column' } },
                  h('a', { href: p.url, target: '_blank', rel: 'noreferrer', style: { display: 'block', lineHeight: 0 } },
                    p.cover
                      ? h('img', { src: p.cover, alt: p.title, loading: 'lazy', style: { width: '100%', height: 150, objectFit: 'cover', background: 'rgba(127,127,127,.15)' } })
                      : h('div', { style: { height: 150, background: 'rgba(127,127,127,.15)' } })),
                  h('div', { style: { padding: '10px 12px', fontSize: 13, lineHeight: 1.7 } },
                    h('a', { href: p.url, target: '_blank', rel: 'noreferrer', style: { color: 'inherit', fontWeight: 600, textDecoration: 'none' } }, p.title),
                    h('div', { style: { opacity: .65, fontSize: 12 } }, (p.up || '') + '　' + fmt(p.play) + ' 播放　' + dur(p.duration)),
                    h('div', { style: { marginTop: 6 } }, h('b', null, '为什么值得：'), p.why),
                    p.mine ? h('div', { style: { marginTop: 4, opacity: .85 } }, '我：' + p.mine) : null))
              })),
            d.notes ? h('div', { style: { marginTop: 8, opacity: .65, fontSize: 12, whiteSpace: 'pre-wrap' } }, '那天的账：' + d.notes) : null)
        }))
    }

    var TABS = [['overview', '概览'], ['persona', '人设·种子'], ['qq', 'QQ'], ['bili', 'B站'], ['prompt', '家的说明书'], ['records', '记录与备份']]

    /** 一份快照的画面；life 为 null（停着，或生活线没能启动）或缺了哪一块都不会崩。 */
    function View(props) {
      var snap = props.snap, error = props.error
      var tabState = useState('overview'), tab = tabState[0], setTab = tabState[1]
      var panelState = useState(null), panel = panelState[0], setPanel = panelState[1]
      var busyState = useState(false), busy = busyState[0], setBusy = busyState[1]
      var failState = useState(null), fail = failState[0], setFail = failState[1]
      var running = snap.running === true
      var name = snap.name && snap.name !== 'TA' ? snap.name : ''
      function power() {
        if (running && !window.confirm('停止后，她不会再被叫醒，记忆块、人设和家的说明书都会撤下，这段时间的对话也不记。要停止吗？')) return
        setBusy(true); setFail(null)
        post(running ? 'stop' : 'start').then(function () { props.refresh() }, function (e) { setFail(String(e.message || e)) }).then(function () { setBusy(false) })
      }
      return h('div', { className: 'dw' },
        h('header', { className: 'dw-head' + (running ? ' dw-on' : '') },
          h('div', { className: 'dw-title' },
            h('small', null, 'home · ' + snap.worldId),
            h('h2', null, (name || '她') + '的家'),
            h('div', { className: 'dw-state' }, h('i', { className: 'dw-dot' }), running ? '运行中' : '已停止', ' · ', local(snap.now, snap.timeZone),
              error ? h('span', { className: 'dw-bad' }, ' · 刷新失败：' + error) : null,
              fail ? h('span', { className: 'dw-bad' }, ' · ' + fail) : null)),
          h('button', { className: 'dw-power' + (running ? ' stop' : ''), disabled: busy, onClick: power }, busy ? '……' : running ? '停止' : '开始')),
        h('nav', { className: 'dw-tabs' }, TABS.map(function (t) { return h('button', { key: t[0], className: 'dw-tab' + (tab === t[0] ? ' on' : ''), onClick: function () { setTab(t[0]) } }, t[1]) })),
        tab === 'overview' ? h(Overview, { snap: snap, refresh: props.refresh, onNeedPassword: setPanel }) : null,
        tab === 'persona' ? h(PersonaEditor, { onSaved: props.refresh }) : null,
        tab === 'prompt' ? h(PromptEditor) : null,
        tab === 'bili' ? h(Bili) : null,
        tab === 'qq' ? h(QqPage) : null,
        tab === 'records' ? h(Records, { snap: snap, tick: props.tick }) : null,
          panel ? h(Panel, { kind: panel, onClose: function () { setPanel(null) } }) : null)
    }

    function Console() {
      var snapState = useState(null), snap = snapState[0], setSnap = snapState[1]
      var errorState = useState(null), error = errorState[0], setError = errorState[1]
      var offState = useState(false), off = offState[0], setOff = offState[1]
      var tickState = useState(0), tick = tickState[0], setTick = tickState[1]
      var loadRef = useRef(null)
      useEffect(function () {
        ensureStyle()
        var alive = true, pending = false, timer = null
        function load() {
          if (!alive || pending) return
          pending = true
          loadSnapshot().then(function (s) {
            pending = false
            if (!alive) return
            if (s === null) { setOff(true); if (timer) { clearInterval(timer); timer = null } return }
            setSnap(s); setError(null); setTick(function (t) { return t + 1 })
          }, function (e) {
            pending = false
            if (alive) setError(String((e && e.message) || e))
          })
        }
        function onVisible() { if (document.visibilityState === 'visible') load() }
        loadRef.current = load
        load()
        timer = setInterval(onVisible, 10000)
        document.addEventListener('visibilitychange', onVisible)
        return function () { alive = false; loadRef.current = null; if (timer) clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
      }, [])
      if (off) return h('div', { className: 'dw' }, h('div', { className: 'dw-muted' }, '世界控制台需要桌面版宿主'))
      if (!snap) return h('div', { className: 'dw' }, error ? h('div', { className: 'dw-bad' }, '读取失败：' + error) : h('div', { className: 'dw-muted' }, '读取中…'))
      return h(View, { snap: snap, error: error, tick: tick, refresh: function () { if (loadRef.current) loadRef.current() } })
    }

    var exports = { inject: ['slots'] }
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    exports.apply = function (ctx) {
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({ name: 'settings.section', id: 'world-console', order: 28, label: '小肥鱼的家' }, function () { return h(Console) })
      })
      // 聊天页那扇「刷过的视频」是从 B站 插件一起搬过来的；宿主没这扇窗就不能把设置页也一起拽坏
      try {
        ctx.slots.inject('conversation.view', function () {
          return ctx.slots.register({ name: 'conversation.view', id: 'world-bili-watched', order: 21, label: '刷过的视频' }, function () { return h(BiliWatch) })
        })
      }
      catch (e) { /* 没有这扇窗就算了 */ }
    }
    Object.defineProperty(exports, '__test', { value: { Modules: Modules, Wechat: Wechat, Activity: Activity, Diary: Diary, Qq: Qq, Panel: Panel, View: View, Overview: Overview, PersonaEditor: PersonaEditor, PromptEditor: PromptEditor, Bili: Bili, BiliWatch: BiliWatch, loadSnapshot: loadSnapshot, renderPersona: renderPersona }, enumerable: false })
    return exports
  },
})
