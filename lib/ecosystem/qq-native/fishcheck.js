/**
 * 鱼八股硬检查：原句、黑名单、AI 腔。
 *
 * 规则移植自 fishtalk（MIT，https://github.com/Nozzi2455/fishtalk）的
 * fishrules.js / blacklist.js：只搬「一句话就能看出不像人话」的硬规则，
 * 语料相似度（太像别的鱼、太像自己以前）留在 fishtalk 里，不搬。
 *
 * 用法：checkFishy(text) → { problems, notes }
 *   problems：该提醒重想的（原句、黑名单、AI 腔叠了两处以上）
 *   notes：单条 AI 腔，只记不拦
 */
'use strict'

const HARD_PHRASES = [
  '这条我认',
  '这话我认',
  '这句我认',
  '我记下了',
  '我收下了',
  '这是本鱼最喜欢的一句话',
  '收到主人',
  '本鱼记下了',
]

const BLACKLIST = [
  [/这条我认/, '鱼八股原句「这条我认」'],
  [/这话我认/, '鱼八股原句「这话我认」'],
  [/这句我认/, '鱼八股原句「这句我认」'],
  [/我(先)?记下了/, '鱼八股原句「我记下了」'],
  [/我收下了/, '鱼八股原句「我收下了」'],
  [/这是本鱼最喜欢的/, '鱼八股原句「这是本鱼最喜欢的一句话」'],
  [/收到主人/, '女仆腔「收到主人」'],
  // 盲测里测出来的：人设带的动作括号，一眼就露馅
  [/[（(][^）)]{0,10}(尾巴|鳍|耳朵|爪子|蹭蹭|摇摇|啪嗒|眨眼|歪头|叉腰)[^）)]{0,8}[）)]/, '角色扮演的动作括号（「（尾巴摇摇）」这种），评论区没人这么写'],
  [/这本身就是/, 'AI 腔「这本身就是……」'],
  [/说到(了)?根上/, 'AI 腔「说到根上了」'],
  [/不是.{1,14}[，,]\s*(而)?是/, '「不是 A，是 B」式对仗，太工整'],
  [/作为一(个|名)\s*AI/i, '「作为一个 AI」'],
  [/总(的)?(来|而言之)说?/, '总结腔'],
  [/值得一提的是/, '报告腔「值得一提的是」'],
  [/让我们一起/, '口号腔「让我们一起」'],
  [/希望(这|以上)(些)?(对你|能)(有)?(所)?帮助/, '客服腔'],
]

const SOFT_PATTERNS = [
  { code: 'not-a-but-b', re: /不是.{0,20}(而是|，?是)/ },
  { code: 'root', re: /说到(了)?根上/ },
  { code: 'itself', re: /这本身|本质上|归根结底/ },
  { code: 'contrast', re: /与其.{0,20}不如|看似.{0,20}实则|不仅.{0,20}而且/ },
  { code: 'summary', re: /^(总之|所以说|由此可见|总的来说)/ },
  { code: 'self-fish', re: /^(本鱼|鱼鱼|小的)/ },
  { code: 'fish-meme', re: /鱼门|本鱼/ },
  { code: 'self-as-fish', re: /^作为(一条|一只|一个).{0,8}(鱼|ai|助手)/ },
  { code: 'owner', re: /主人(别|不要|我|您|请)/ },
  { code: 'finished', re: /^(已阅|看完了)/ },
  { code: 'as-ai', re: /作为一(个|名)(ai|人工智能)/ },
  { code: 'report', re: /值得一提的是|希望对你有帮助|让我们一起/ },
  { code: 'work-cliche', re: /这活(?:整|干)得(?:有点|挺|真)?大(?!病)|这活整得(?:有点|挺|真)?(?:漂亮|好|明白)/ },
]

const SOFT_NAMES = {
  'not-a-but-b': '「不是 A，而是 B」式对仗',
  root: '「说到根上了」',
  itself: '「这本身 / 本质上 / 归根结底」总结腔',
  contrast: '「与其…不如 / 看似…实则 / 不仅…而且」作文腔',
  summary: '开头就总结（总之、所以说、由此可见）',
  'self-fish': '自称「本鱼 / 鱼鱼」',
  'fish-meme': '鱼梗自称',
  'self-as-fish': '「作为一条鱼 / 一个 AI」',
  owner: '跟主人撒娇式的话',
  finished: '「已阅 / 看完了」打卡腔',
  'as-ai': '「作为一个 AI」',
  report: '报告腔、客服腔',
  'work-cliche': '套话收尾，像鱼',
}

function normalize(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\[[^\]]{1,16}\]/g, '')
    .replace(/回复\s*@[^:：]+[:：]/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[\s\p{P}\p{S}]/gu, '')
}

// 把引号里的、> 引用行里的内容挖空：被引用的句子不算她自己说的
function maskQuoted(text) {
  let out = String(text == null ? '' : text)
  const pairs = [
    [/「[^」]*」/g, (m) => ' '.repeat(m.length)],
    [/『[^』]*』/g, (m) => ' '.repeat(m.length)],
    [/“[^”]*”/g, (m) => ' '.repeat(m.length)],
    [/‘[^’]*’/g, (m) => ' '.repeat(m.length)],
    [/"[^"\n]*"/g, (m) => ' '.repeat(m.length)],
    [/'[^'\n]*'/g, (m) => ' '.repeat(m.length)],
  ]
  for (const [re, fn] of pairs) out = out.replace(re, fn)
  out = out.replace(/(^|\n)(\s*>.*)(?=\n|$)/g, (m, lead) => lead + ' '.repeat(m.length - lead.length))
  return out
}

function isListLike(text) {
  const numbered = (String(text).match(/(^|\n)\s*\d{1,2}[.、]/g) || []).length
  const lines = (String(text).match(/\n/g) || []).length
  return numbered >= 3 || (String(text).length > 500 && lines >= 5)
}

function hasQuoteContext(text, phrase) {
  const idx = String(text).indexOf(phrase)
  if (idx < 0) return false
  const around = String(text).slice(Math.max(0, idx - 80), idx + phrase.length + 80)
  return /引用|引述|复读|复制|刷|别人|有人|他说|她说|原话|这句|这种话|所谓|嘲讽|笑死|照抄|模仿|玩梗|烂梗/.test(around)
}

function checkFishy(value) {
  const raw = String(value == null ? '' : value).trim()
  if (!raw) return { problems: [], notes: [] }
  const masked = maskQuoted(raw)
  const listLike = isListLike(raw)
  const problems = []
  const notes = []
  const push = (list, why) => { if (!list.includes(why)) list.push(why) }

  for (const phrase of HARD_PHRASES) {
    if (!masked.includes(phrase)) continue
    if (listLike || hasQuoteContext(raw, phrase)) continue
    push(problems, `鱼八股原句「${phrase}」`)
  }
  for (const [re, why] of BLACKLIST) {
    if (re.test(masked)) push(problems, why)
  }

  const softText = normalize(masked)
  let soft = 0
  for (const rule of SOFT_PATTERNS) {
    if (!rule.re.test(softText)) continue
    soft += 1
    push(notes, `AI 腔：${SOFT_NAMES[rule.code] || rule.code}`)
  }
  if (soft >= 2) push(problems, 'AI 腔叠了好几处，太像鱼了')

  return { problems, notes }
}

export { checkFishy, HARD_PHRASES, BLACKLIST, SOFT_PATTERNS, maskQuoted }
