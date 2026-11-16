/* 씬플로우: dependency-free, mobile-first TRPG scenario helper.
 * Data stays in the local browser (IndexedDB, localStorage fallback).
 * No direct CCFOLIA communication: copy text to clipboard and paste there.
 */
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, x => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
const uid = () => globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const clone = obj => JSON.parse(JSON.stringify(obj));
const stamp = () => new Date().toISOString();
const kinds = {text:'지문',npc:'NPC 대사',check:'판정',branch:'선택·분기',ending:'엔딩',note:'진행 메모'};
const kindIcons = {text:'✦',npc:'◈',check:'⚄',branch:'⑂',ending:'✧',note:'▤'};
const storeName = 'sceneflow-v1';
const memoryFallback = new Map();
function safeGet(key){try{return localStorage.getItem(key);}catch{return memoryFallback.get(key)??null;}}
function safeSet(key,value){try{localStorage.setItem(key,value);}catch{memoryFallback.set(key,value);}}
function getBackup(){try{return JSON.parse(safeGet('sf-backup')||'[]');}catch{return [];}}
let dbPromise;
let saveTimer;
let toastTimer;
const ui = {tab:'play',editorSceneId:null,editorEntryId:null,sourceQuery:'',sourceMatch:0,sourceTransformed:true};
let scenarios = [];
let scenario = null;
// Window mode: auto adapts to Galaxy multi-window sizes; users can override it.
let splitPreference = safeGet('sf-window-mode') || 'auto';
let deferredInstallPrompt = null;
function detectCompactWindow(){
  return window.innerWidth <= 330 || (window.innerWidth <= 900 && window.innerHeight <= 540);
}
function applyWindowMode(){
  const enabled = splitPreference === 'on' || (splitPreference === 'auto' && detectCompactWindow());
  document.body.classList.toggle('split-mode', enabled);
  const toggle = $('#toggle-split');
  if(toggle){
    toggle.setAttribute('aria-pressed',String(enabled));
    toggle.title = enabled ? '분할 화면 모드 끄기' : '분할 화면 모드 켜기';
    toggle.setAttribute('aria-label', enabled ? '분할 화면 모드 끄기' : '분할 화면 모드 켜기');
  }
}
function toggleSplitMode(){
  const wasEnabled = document.body.classList.contains('split-mode');
  splitPreference = wasEnabled ? 'off' : 'on';
  safeSet('sf-window-mode',splitPreference);
  applyWindowMode();
  toast(wasEnabled ? '일반 화면으로 전환했어요.' : '분할 화면에 맞게 화면을 줄였어요.');
}
function resetSplitAuto(){
  splitPreference = 'auto';
  safeSet('sf-window-mode','auto');
  applyWindowMode();
  toast('창 크기에 따라 자동으로 전환돼요.');
}
function isInstalled(){
  return window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
}
function openInstallHelp(){
  const state = isInstalled() ? '이미 홈 화면 앱으로 실행 중이에요.' : '웹사이트를 HTTPS 주소로 연 다음 브라우저 메뉴에서 홈 화면에 추가 / 앱 설치를 선택해 주세요.';
  showModal(`${modalHead('앱 설치 · 멀티윈도우','코코포리아와 나란히 실행하기 위한 안내예요.')}
  <p class="subtle"><strong>설치 상태:</strong> ${esc(state)}</p>
  <div class="editor-warning">HTML 파일을 다운로드해 여는 것만으로는 PWA가 설치되지 않아요. 웹앱 파일을 GitHub Pages 등 HTTPS 사이트에 게시해야 홈 화면 설치와 오프라인 캐시가 동작합니다.</div>
  <div class="form-group"><strong>① 설치하기</strong><p class="subtle">Chrome 또는 Samsung Internet에서 배포한 씬플로우 주소를 열고 메뉴 → 앱 설치 / 홈 화면에 추가를 선택하세요.</p></div>
  <div class="form-group"><strong>② 화면 나누기</strong><p class="subtle">Galaxy 최근 앱 화면에서 씬플로우 아이콘 → 분할 화면으로 열기 또는 팝업 화면으로 열기를 고른 뒤 코코포리아를 다른 창에 띄우세요.</p></div>
  <div class="form-group"><strong>③ 복사해서 플레이</strong><p class="subtle">씬플로우에서 지문 복사 → 코코포리아 채팅창에 붙여넣기. 창이 작아지면 자동으로 간단 화면이 됩니다.</p></div>
  <div class="button-row"><button class="btn btn-soft" data-action="split-toggle">▣ 분할 화면 전환</button><button class="btn" data-action="split-auto">화면 크기에 맞춰 자동</button></div>
  <div class="modal-footer">${deferredInstallPrompt && !isInstalled()?'<button class="btn btn-primary" data-action="install-now">앱 설치</button>':''}<button class="btn" data-action="close-modal">닫기</button></div>`);
}
async function installNow(){
  if(!deferredInstallPrompt){openInstallHelp();return;}
  const prompt=deferredInstallPrompt;deferredInstallPrompt=null;
  closeModal();
  await prompt.prompt();
}


function db() {
  if (!('indexedDB' in window)) return Promise.reject(new Error('IndexedDB not available'));
  if (!dbPromise) dbPromise = new Promise((resolve,reject)=>{
    const request=indexedDB.open(storeName,1);
    request.onupgradeneeded=()=>request.result.createObjectStore('scenarios',{keyPath:'id'});
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
  return dbPromise;
}
async function dbOp(mode, callback) {
  const database = await db();
  return new Promise((resolve,reject)=>{
    const tx=database.transaction('scenarios',mode);
    const req=callback(tx.objectStore('scenarios'));
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
    tx.onerror=()=>reject(tx.error);
  });
}
const storage = {
  async all(){try{return await dbOp('readonly',s=>s.getAll());}catch{return getBackup();}},
  async put(item){try{await dbOp('readwrite',s=>s.put(clone(item)));}catch{const all=getBackup();const i=all.findIndex(x=>x.id===item.id);if(i<0)all.push(clone(item));else all[i]=clone(item);try{safeSet('sf-backup',JSON.stringify(all));}catch{toast('저장 공간이 부족해요. JSON 백업을 내려받아 주세요.');}}},
  async del(id){try{await dbOp('readwrite',s=>s.delete(id));}catch{const all=getBackup().filter(x=>x.id!==id);safeSet('sf-backup',JSON.stringify(all));}}
};
function toast(message){const node=$('#toast');node.textContent=message;node.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>node.classList.remove('visible'),2700);}
function remember(){if(!scenario)return;scenario.updatedAt=stamp();const i=scenarios.findIndex(s=>s.id===scenario.id);if(i<0)scenarios.push(scenario);else scenarios[i]=scenario;clearTimeout(saveTimer);saveTimer=setTimeout(()=>storage.put(scenario),500);}
async function saveNow(){clearTimeout(saveTimer);if(scenario)await storage.put(scenario);}
function option(label,text='',targetSceneId=''){return {id:uid(),label,text,targetSceneId};}
function entry(kind='text',text='',extra={}){return {id:uid(),kind,title:'',text,speaker:'',options:[],...extra};}
function sceneObj(title='새 장면',entries=[entry()]){return {id:uid(),title,entries};}
function wrapScenario(title,source,scenes){const first=scenes.flatMap(s=>s.entries)[0];return {formatVersion:1,id:uid(),title:title||'제목 없는 시나리오',source:source||'',scenes,current:{entryId:first?.id??'',pendingOptionId:null},history:[],visited:[],settings:{includeSpeaker:false,hideFuture:true,nameMappings:{kpc:{from:'KPC',to:''},pc:{from:'탐사자',to:''}}},createdAt:stamp(),updatedAt:stamp()};}
/* Name personalization only changes what is displayed/copied/exported. Raw scenes and original source remain intact. */
function nameMaps(){
  const custom=scenario?.settings?.nameMappings || {};
  return {
    kpc:{from:'KPC',to:'',...custom.kpc},
    pc:{from:'탐사자',to:'',...custom.pc}
  };
}
function koreanEnding(name){
  const last=String(name||'').trim().slice(-1);
  const code=last.charCodeAt(0);
  if(!(code>=0xAC00&&code<=0xD7A3))return null;
  const jong=(code-0xAC00)%28;
  return {hasBatchim:jong!==0,rieul:jong===8};
}
function correctedParticle(name,original){
  const ending=koreanEnding(name);
  if(!ending)return original; // Foreign names have ambiguous Korean pronunciations; don't guess.
  const c=ending.hasBatchim,r=ending.rieul;
  const norm=original.replace(/^\(|\)$/g,'');
  const pairs={
    '은/는':c?'은':'는', '이/가':c?'이':'가', '을/를':c?'을':'를',
    '과/와':c?'과':'와', '으로/로':c&&!r?'으로':'로',
    '이랑/랑':c?'이랑':'랑', '아/야':c?'아':'야',
    '은':c?'은':'는','는':c?'은':'는',
    '이':c?'이':'가','가':c?'이':'가',
    '을':c?'을':'를','를':c?'을':'를',
    '과':c?'과':'와','와':c?'과':'와',
    '으로':c&&!r?'으로':'로','로':c&&!r?'으로':'로',
    '이랑':c?'이랑':'랑','랑':c?'이랑':'랑',
    '아':c?'아':'야','야':c?'아':'야'
  };
  if(original==='(으)로')return c&&!r?'으로':'로';
  return pairs[norm]??original;
}
function personalize(input){
  const raw=String(input??'');
  if(!scenario)return raw;
  const aliases=new Map();
  for(const item of Object.values(nameMaps())){
    const to=String(item.to??'').trim();
    if(!to)continue;
    for(const alias of String(item.from??'').split(/[,，\n]/).map(s=>s.trim()).filter(Boolean)){
      if(alias.toLocaleLowerCase()!==to.toLocaleLowerCase()&&!aliases.has(alias.toLocaleLowerCase()))aliases.set(alias.toLocaleLowerCase(),to);
    }
  }
  if(!aliases.size)return raw;
  const escapeRe=part=>part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const all=[...aliases.keys()].sort((a,b)=>b.length-a.length).map(escapeRe).join('|');
  const particle=String.raw`(\(으\)로|\((?:은/는|이/가|을/를|과/와|으로/로|이랑/랑|아/야)\)|은/는|이/가|을/를|과/와|으로/로|이랑/랑|아/야|으로|이랑|은|는|이|가|을|를|과|와|로|랑|아|야)?`;
  const trailing=String.raw`(?=$|[^\p{L}\p{N}_]|(?:에게서|한테서|에게|한테|께서|께|에서|부터|까지|의|도|만|마다|조차|마저|밖에|처럼|보다|하고|에|님|씨|들))`;
  const re=new RegExp(String.raw`(^|[^\p{L}\p{N}_])(${all})`+particle+trailing,'giu');
  return raw.replace(re,(_,prefix,alias,postfix)=>{
    const name=aliases.get(alias.toLocaleLowerCase())||alias;
    return prefix+name+(postfix?correctedParticle(name,postfix):'');
  });
}
function sourceDisplayText(){return ui.sourceTransformed?personalize(scenario.source||''):scenario.source||'';}
function namesExample(){const maps=nameMaps();const first=maps.kpc.from.split(/[,，\n]/).map(x=>x.trim()).find(Boolean)||'KPC';const second=maps.pc.from.split(/[,，\n]/).map(x=>x.trim()).find(Boolean)||'탐사자';return personalize(`${first}가 ${second}를 바라본다. ${second}는 ${first}와 함께 문으로 향한다.`);}
function demo(){
  const a=sceneObj('저택의 현관',[
    entry('text','빗소리가 들리는 밤. 오래된 저택의 문이 천천히 열린다.'),
    entry('npc','어서 오십시오. 오래 기다리고 있었습니다.',{speaker:'집사'}),
    entry('note','PC와 KPC의 자유 RP를 진행한 뒤 다음으로 넘어가세요. 이 메모는 코코포리아에 출력하지 않아도 됩니다.')
  ]);
  const b=sceneObj('어두운 복도',[
    entry('text','복도 끝에 낡은 초상화 한 점이 걸려 있다.'),
    entry('check','초상화를 자세히 살펴본다면 관찰력 판정을 진행하세요.',{title:'관찰력 판정',options:[option('성공','액자 뒤에 숨겨진 쪽지를 발견한다.'),option('실패','특별한 단서는 발견하지 못했다.')]}),
    entry('npc','늦은 시간에는 이쪽으로 오지 않으시는 편이 좋습니다.',{speaker:'집사'})
  ]);
  const c=sceneObj('마지막 선택',[
    entry('text','밖으로 나갈 수 있는 문이 눈앞에 나타난다.'),
    entry('branch','탐사자는 어떤 선택을 할까?',{title:'엔딩 분기'})
  ]);
  const ea=sceneObj('ENDING A · 귀환',[entry('ending','문이 열리고 탐사자는 저택 밖으로 나온다. 이 이야기는 여기서 끝난다.')]);
  const eb=sceneObj('ENDING B · 잔류',[entry('ending','탐사자는 저택에 남기로 한다. 이 이야기는 여기서 끝난다.')]);
  c.entries[1].options=[option('저택에서 나간다','문밖을 향해 걸음을 옮긴다.',ea.id),option('저택에 남는다','한 번 더 저택 안을 돌아본다.',eb.id)];
  const raw=`# 저택의 현관\n빗소리가 들리는 밤. 오래된 저택의 문이 천천히 열린다.\n집사: 어서 오십시오. 오래 기다리고 있었습니다.\n\n# 어두운 복도\n복도 끝에 낡은 초상화 한 점이 걸려 있다.\n[판정: 관찰력]\n[성공] 액자 뒤에 숨겨진 쪽지를 발견한다.\n[실패] 특별한 단서는 발견하지 못했다.\n\n# 마지막 선택\n밖으로 나갈 수 있는 문이 눈앞에 나타난다.\n[분기] 탐사자는 어떤 선택을 할까?`;
  return wrapScenario('샘플 · 저택의 비밀',raw,[a,b,c,ea,eb]);
}
/*
 * 원문 분할 규칙:
 * - #로 시작하는 줄 / SCENE·장면 표기 = 새 장면
 * - 단독 ENDING A / B / C 등 = 각 엔딩 장면
 * - '판정' 안내 다음 성공:·실패: = 한 개의 선택형 판정 이벤트
 * - 일반 지문은 빈 줄 없이 엔터 한 번으로 이벤트를 각각 생성
 * 원문 전체는 scenario.source에 변경 없이 남습니다.
 */
function parseSource(raw,name='새 시나리오'){
  const lines=String(raw||'').replace(/\r\n?/g,'\n').split('\n');
  const scenes=[];
  let current=sceneObj('도입',[]);
  scenes.push(current);
  let buffer=[],activeOutcome=null,lastCheck=null;
  const outcomePattern=/^(?:[-*•]\s*)?(?:\*\*)?\s*(?:[\[【(]\s*)?(대성공|극단적\s*성공|어려운\s*성공|성공|실패|대실패|펌블|크리티컬)(?:\s*[\]】)])?(?:\*\*)?\s*(?:[:：]|[-–—]|\s+)(?:\s*(.*))?$/i;
  const bareOutcomePattern=/^(?:[-*•]\s*)?(?:\*\*)?\s*(?:[\[【(]\s*)?(대성공|극단적\s*성공|어려운\s*성공|성공|실패|대실패|펌블|크리티컬)\s*[\]】)](?:\*\*)?\s*(.*)$/i;
  const parseOutcome=line=>{
    // '성공:' '실패：', '- 성공:...', '[성공] 내용', '**실패:** 내용' 등
    const bracket=line.match(bareOutcomePattern);
    if(bracket)return [bracket[1].replace(/\s+/g,' ').trim(),(bracket[2]||'').trim().replace(/^[:：]\s*/, '')];
    const named=line.match(outcomePattern);
    if(named)return [named[1].replace(/\s+/g,' ').trim(),(named[2]||'').trim()];
    // 콜론이 없는 '성공' / '실패' 단독 줄도 허용
    const only=line.match(/^(?:[-*•]\s*)?(대성공|극단적\s*성공|어려운\s*성공|성공|실패|대실패|펌블|크리티컬)\s*$/i);
    return only?[only[1], '']:null;
  };
  const checkHeader=line=>{
    let m=line.match(/^[\[【(]\s*(?:판정|체크|다이스)\s*(?:[:：]\s*([^\]】)]+))?[\]】)]\s*(.*)$/i);
    if(m)return {title:(m[1]||'판정').trim(),text:(m[2]||'').trim(),explicit:true};
    // 【관찰력 판정】, [행운 판정]처럼 판정명이 대괄호 안에 들어간 경우
    m=line.match(/^[\[【(]\s*([^\]】)]+판정[^\]】)]*)\s*[\]】)]\s*(.*)$/i);
    if(m)return {title:m[1].trim(),text:(m[2]||'').trim()||m[1].trim(),explicit:true};
    m=line.match(/^(?:[-*•]\s*)?(?:\*\*)?\s*(?:판정|체크|다이스)(?:\s*[:：]\s*(.+))?(?:\*\*)?\s*$/i);
    if(m)return {title:(m[1]||'판정').trim(),text:line,explicit:true};
    m=line.match(/^(?:[-*•]\s*)?(?:\*\*)?(.{1,45}?\s*판정)(?:\s*[:：]\s*(.*))?(?:\*\*)?\s*$/i);
    if(m)return {title:m[1].trim(),text:line,explicit:false};
    // 시나리오의 일반 문장에도 '판정'이 등장하고 뒤에 결과가 있으면 판정 처리.
    if(line.includes('판정')&&line.length<=350)return {title:'판정',text:line,explicit:false};
    return null;
  };
  const endingHeading=line=>{
    const clean=line.replace(/^[【\[]\s*/, '').replace(/\s*[\]】]$/, '').trim().replace(/^\*\*(.+)\*\*$/, '$1').trim();
    return /^(?:ENDING|엔딩)\s*[A-Z0-9]+(?:\s*(?:[:：.\-–—]\s*.+|\(.+\)))?$/i.test(clean)?clean:null;
  };
  const headingTitle=line=>{
    let m=line.match(/^#{1,6}\s*(.*)$/); // # 뒤 공백은 없어도 됨
    if(m)return {title:m[1].trim(),isHeading:true};
    m=line.match(/^[【\[]\s*(?:장면|씬|SCENE)\s*[:：\s-]*([^\]】]+)[\]】]$/i);
    if(m)return {title:m[1].trim(),isHeading:true};
    m=line.match(/^(?:SCENE|장면|씬)\s*\d*\s*[:：.\-]\s*(.+)$/i);
    return m?{title:m[1].trim(),isHeading:true}:null;
  };
  const flush=()=>{
    const text=buffer.join('\n').trim();buffer=[];
    if(!text)return;
    if(activeOutcome)activeOutcome.text+=(activeOutcome.text?'\n':'')+text;
    else current.entries.push(entry('text',text));
  };
  const newScene=(title,isEnding=false)=>{
    flush();activeOutcome=null;lastCheck=null;
    const realTitle=title||`장면 ${scenes.length+1}`;
    if(scenes.length===1&&current.title==='도입'&&!current.entries.length){
      current.title=realTitle;
    }else{
      current=sceneObj(realTitle,[]);
      scenes.push(current);
    }
    if(isEnding)current.isEnding=true;
  };
  const nextHasResult=from=>{
    let nonempty=0;
    for(let j=from+1;j<lines.length&&nonempty<8;j++){
      const line=lines[j].trim();
      if(!line)continue;
      if(headingTitle(line)||endingHeading(line)||/^\[\s*(?:분기|선택|선택지)\s*\]/i.test(line))return false;
      if(parseOutcome(line))return true;
      if(checkHeader(line))return false;
      nonempty++;
    }
    return false;
  };
  for(let i=0;i<lines.length;i++){
    const rawLine=lines[i];
    const line=rawLine.trim();
    let m;
    const heading=headingTitle(line);
    if(heading){
      newScene(heading.title,!!endingHeading(heading.title));
      continue;
    }
    const end=endingHeading(line);
    if(end){newScene(end,true);continue;}
    // [ENDING A] 첫 문장처럼 같은 줄에 지문이 붙은 표기도 지원
    if((m=line.match(/^[\[【]\s*((?:ENDING|엔딩)\s*[A-Z0-9]+)\s*[\]】]\s*(.+)$/i))){
      newScene(m[1].trim(),true);
      buffer.push(m[2]);
      continue;
    }
    const check=checkHeader(line);
    if(check&&(check.explicit||nextHasResult(i))){
      flush();activeOutcome=null;
      const title=check.title||'판정';
      lastCheck=entry('check',check.text||`${title} 판정을 진행하세요.`,{title,options:[option('성공'),option('실패')]});
      current.entries.push(lastCheck);
      continue;
    }
    const outcome=parseOutcome(line);
    if(outcome&&lastCheck){
      flush();activeOutcome=null;
      let label=outcome[0];
      if(label==='크리티컬')label='대성공';
      if(label==='펌블')label='대실패';
      let opt=lastCheck.options.find(o=>o.label===label);
      if(!opt){opt=option(label);lastCheck.options.push(opt);}
      opt.text=outcome[1];
      activeOutcome=opt;
      continue;
    }
    if((m=line.match(/^[\[【]\s*(?:분기|선택지|선택)\s*[\]】]\s*(.*)$/i))){
      flush();activeOutcome=null;lastCheck=null;
      current.entries.push(entry('branch',m[1]?.trim()||'선택지를 선택하세요.',{title:'분기 선택',options:[option('선택지 A'),option('선택지 B')]}));
      continue;
    }
    if((m=line.match(/^[\[【]\s*NPC\s*[:：]\s*([^\]】]+)[\]】]\s*(.*)$/i))){
      flush();activeOutcome=null;lastCheck=null;
      current.entries.push(entry('npc',m[2]?.trim()||'',{speaker:m[1].trim()}));
      continue;
    }
    if((m=line.match(/^([^\s:：][^:：]{0,17})\s*[:：]\s*(.+)$/)) && !/^(?:시나리오|제목|시간|장소|일시|조건|주의|메모|내용|성공|실패|대성공|대실패|판정|선택지|엔딩|정보)$/i.test(m[1].trim())){
      flush();activeOutcome=null;lastCheck=null;
      current.entries.push(entry('npc',m[2].trim(),{speaker:m[1].trim()}));
      continue;
    }
    if(!line){flush();activeOutcome=null;continue;}
    // 결과 줄은 들여쓴 후속 줄 또는 값 없는 '성공:' 바로 뒤 한 줄만 이어 붙임.
    // 그 외 일반 줄은 엔터 한 번만 있어도 별도의 복사 이벤트가 됨.
    if(activeOutcome&&(!activeOutcome.text||/^(?:\t| {2,})\S/.test(rawLine))){
      activeOutcome.text+=(activeOutcome.text?'\n':'')+line;
      continue;
    }
    flush();activeOutcome=null;current.entries.push(entry('text',line));
  }
  flush();
  for(const sc of scenes){
    if(!sc.entries.length){
      sc.entries.push(sc.isEnding?entry('ending','',{title:sc.title}):entry('note','이 장면에는 아직 출력할 지문이 없어요. 편집 탭에서 추가하세요.'));
    }else if(sc.isEnding){
      // 마지막 지문이 있다면 엔딩 이벤트로 표시합니다. NPC가 마지막인 경우
      // 장면 자체의 isEnding 플래그로 이후 엔딩으로의 자동 진행을 막습니다.
      const last=sc.entries[sc.entries.length-1];
      if(last.kind==='text'){last.kind='ending';last.title=sc.title;}
    }
  }
  const endingScenes=scenes.filter(sc=>sc.isEnding);
  if(endingScenes.length>=2){
    const endingIndex=scenes.indexOf(endingScenes[0]);
    const preceding=[...scenes.slice(0,endingIndex)].reverse().find(sc=>!sc.isEnding);
    const choices=endingScenes.map(sc=>option(sc.title,'',sc.id));
    if(preceding){
      const last=preceding.entries[preceding.entries.length-1];
      if(last?.kind==='branch'&&last.options.every(o=>!o.targetSceneId&&/^선택지\s*[A-Z0-9]+$/i.test(o.label))){
        last.options=choices;
        if(!last.text||last.text==='선택지를 선택하세요.')last.text='진행할 엔딩을 선택하세요.';
      }else{
        preceding.entries.push(entry('branch','진행할 엔딩을 선택하세요.',{title:'엔딩 분기',options:choices}));
      }
    }else{
      scenes.unshift(sceneObj('엔딩 선택',[entry('branch','진행할 엔딩을 선택하세요.',{title:'엔딩 분기',options:choices})]));
    }
  }
  return wrapScenario(name,raw,scenes);
}
function normalizeImported(data){
  if(!data||!Array.isArray(data.scenes)||!data.scenes.length)throw new Error('시나리오 데이터 형식이 올바르지 않아요.');
  const copy=clone(data);copy.id=uid();copy.createdAt=stamp();copy.updatedAt=stamp();
  for(const sc of copy.scenes){sc.id=String(sc.id||uid());sc.title=String(sc.title||'장면');sc.isEnding=!!sc.isEnding;sc.entries=Array.isArray(sc.entries)?sc.entries:[];if(!sc.entries.length)sc.entries.push(entry('note','빈 장면'));
    for(const e of sc.entries){e.id=String(e.id||uid());e.kind=kinds[e.kind]?e.kind:'text';e.text=String(e.text||'');e.speaker=String(e.speaker||'');e.title=String(e.title||'');e.options=Array.isArray(e.options)?e.options.map(o=>({id:String(o.id||uid()),label:String(o.label||'선택지'),text:String(o.text||''),targetSceneId:String(o.targetSceneId||'')})):[];}}
  copy.title=String(copy.title||'가져온 시나리오');copy.source=String(copy.source||'');copy.current={entryId:copy.scenes[0].entries[0].id,pendingOptionId:null};copy.visited=[];copy.history=[];copy.settings={includeSpeaker:false,hideFuture:true,...copy.settings};return copy;
}
function findPosition(entryId){if(!scenario)return null;for(let si=0;si<scenario.scenes.length;si++){const ei=scenario.scenes[si].entries.findIndex(e=>e.id===entryId);if(ei!==-1)return {si,ei,scene:scenario.scenes[si],entry:scenario.scenes[si].entries[ei]};}return null;}
function currentPos(){let pos=findPosition(scenario?.current?.entryId);if(!pos&&scenario){scenario.current={entryId:scenario.scenes[0].entries[0].id,pendingOptionId:null};pos=findPosition(scenario.current.entryId);}return pos;}
function allEntries(){return scenario.scenes.flatMap(sc=>sc.entries);}
function nextEntryId(pos){if(!pos)return '';if(pos.ei+1<pos.scene.entries.length)return pos.scene.entries[pos.ei+1].id;for(let i=pos.si+1;i<scenario.scenes.length;i++)if(scenario.scenes[i].entries[0])return scenario.scenes[i].entries[0].id;return '';}
function optionChosen(pos){return pos?.entry.options.find(o=>o.id===scenario.current.pendingOptionId);}
function nextDestination(pos){if(pos?.entry.kind==='ending'&&!scenario.current.pendingOptionId)return '';if(pos?.scene?.isEnding&&pos.ei===pos.scene.entries.length-1)return '';const chosen=optionChosen(pos);if(chosen?.targetSceneId){const target=scenario.scenes.find(s=>s.id===chosen.targetSceneId);if(target?.entries[0])return target.entries[0].id;}return nextEntryId(pos);}
function pushHistory(){scenario.history.push(clone(scenario.current));if(scenario.history.length>300)scenario.history.shift();}
function goTo(id){if(!findPosition(id))return toast('이동할 장면을 찾을 수 없어요.');pushHistory();scenario.current={entryId:id,pendingOptionId:null};if(!scenario.visited.includes(id))scenario.visited.push(id);remember();render();window.scrollTo({top:0,behavior:'smooth'});}
function prev(){const last=scenario.history.pop();if(!last)return;scenario.current=last;remember();render();}
function advance(){const pos=currentPos();if(!pos)return;
  if(['check','branch'].includes(pos.entry.kind)&&!scenario.current.pendingOptionId){toast('먼저 판정 결과 또는 선택지를 골라 주세요.');return;}
  const id=nextDestination(pos);if(!id){toast(pos.entry.kind==='ending'?'엔딩에 도착했어요!':'마지막 이벤트입니다. 수고했어요!');return;}
  goTo(id);
}
function chooseOption(optionId){const pos=currentPos();if(!pos||!pos.entry.options.some(o=>o.id===optionId))return;pushHistory();scenario.current.pendingOptionId=optionId;remember();render();}
function effectiveText(){const pos=currentPos();if(!pos)return '';const opt=optionChosen(pos);if(opt)return opt.text||'';return pos.entry.text||'';}
function copyTextForCurrent(){const pos=currentPos();if(!pos)return '';const text=effectiveText();if(!text)return '';if(!scenario.current.pendingOptionId&&pos.entry.kind==='npc'&&scenario.settings.includeSpeaker&&pos.entry.speaker)return personalize(`${pos.entry.speaker}: ${text}`);return personalize(text);}
async function copyToClipboard(text){if(!text){toast('복사할 지문이 없어요.');return;}
  try{if(navigator.clipboard?.writeText&&window.isSecureContext){await navigator.clipboard.writeText(text);}else{const ta=document.createElement('textarea');ta.value=text;ta.setAttribute('readonly','');ta.style.cssText='position:fixed;opacity:0;left:0;top:0';document.body.appendChild(ta);ta.select();ta.setSelectionRange(0,ta.value.length);if(!document.execCommand('copy'))throw new Error('copy denied');ta.remove();}toast('복사 완료! 코코포리아에 붙여넣으세요.');}
  catch{toast('자동 복사가 막혔어요. 지문을 길게 눌러 복사해 주세요.');}
}
function currentIndex(pos){return allEntries().findIndex(e=>e.id===pos.entry.id)+1;}
function renderSidebar(){const el=$('#sidebar');if(!scenario){el.innerHTML='';return;}const pos=currentPos();const spoilers=scenario.settings.hideFuture;const seen=new Set(scenario.visited);el.innerHTML=`<div class="sidebar-section"><div class="sidebar-label">NOW PLAYING</div><div class="sidebar-title scenario-name">${esc(personalize(scenario.title))}</div><p class="sidebar-counter">총 ${scenario.scenes.length}개 장면 · ${allEntries().length}개 이벤트</p><button class="btn btn-soft wide" data-action="library">＋ 시나리오 관리</button></div><div class="sidebar-section"><div class="sidebar-label">SCENE LIST <span>${scenario.scenes.length}</span></div>${scenario.scenes.map((s,i)=>{const future=spoilers&&i>pos.si&&!s.entries.some(e=>seen.has(e.id));return `<button class="scene-link ${s.id===pos.scene.id?'current':''}" data-action="jump-scene" data-id="${esc(s.id)}" title="${esc(future?'미방문 장면':personalize(s.title))}"><span class="scene-num">${String(i+1).padStart(2,'0')}</span><span class="scene-title">${future?'🔒 미방문 장면':esc(personalize(s.title))}</span><span class="scene-count">${s.entries.length}</span></button>`;}).join('')}</div><div class="sidebar-note">✦ 코코포리아와 직접 연결하지 않아요.<br>지문을 복사한 뒤 코코포리아 채팅창에 붙여넣으면 됩니다.</div>`;}
function renderPlay(){const pos=currentPos();if(!pos)return '<div class="empty">이벤트가 없습니다.</div>';
  const total=allEntries().length,idx=currentIndex(pos),percent=Math.max(4,Math.round(idx/total*100));
  const chosen=optionChosen(pos),e=pos.entry,kind=chosen?'result':e.kind;const label=chosen?'선택 결과':kinds[e.kind];const who=chosen?chosen.label:e.kind==='npc'?e.speaker||'NPC':e.title||({text:'시나리오',check:'판정 안내',branch:'선택지',ending:'엔딩',note:'진행 메모'}[e.kind]);
  const body=effectiveText(),requiresOption=!chosen&&['check','branch'].includes(e.kind);
  const nextId=nextDestination(pos);const canNext=!requiresOption&&!!nextId;
  let extra='';
  if(requiresOption)extra=`<div class="options-wrap"><div class="options-title">${e.kind==='check'?'🎲 판정 결과를 선택하세요':'⑂ 진행할 분기를 선택하세요'}</div><div class="option-list">${e.options.map(o=>`<button class="option-btn" data-action="choose" data-id="${esc(o.id)}">${esc(personalize(o.label))} <span style="float:right;color:#bb8da0">›</span></button>`).join('')||'<p class="subtle">선택지가 없어요. 편집 탭에서 추가해 주세요.</p>'}</div></div>`;
  if(chosen)extra=`<p class="subtle" style="margin-top:16px">선택 결과를 복사한 후 다음을 누르면 ${chosen.targetSceneId?'지정된 장면':'다음 이벤트'}으로 이동합니다.</p>`;
  const note=e.kind==='note'&&!chosen;
  return `<div class="section-top"><div><div class="eyebrow">SCENARIO / ${String(pos.si+1).padStart(2,'0')}</div><h1 class="page-title">${esc(personalize(pos.scene.title))}</h1><div class="subtle">이벤트 ${idx} / ${total} · ${esc(personalize(scenario.title))}</div></div><div class="progress-wrap"><span class="subtle">전체 이벤트 위치 ${percent}%</span><div class="progress-track"><div class="progress-fill" style="width:${percent}%"></div></div></div></div>
  <div class="play-grid"><div><article class="stage-card"><div class="stage-header"><h2 class="speaker">${esc(personalize(who))}</h2><div class="chips"><span class="chip ${esc(e.kind)}">${kindIcons[e.kind]||'◌'} ${esc(label)}</span></div></div>
  ${chosen?`<div class="result-banner">✓ ${esc(personalize(chosen.label))} 선택 완료</div>`:''}<div class="stage-body ${body.length<160?'large':''}" id="current-stage-text">${esc(personalize(body)||(!chosen&&note?'메모가 비어 있어요.':'결과 지문이 비어 있어요. 편집 탭에서 입력할 수 있어요.'))}</div>${extra}
  <footer class="stage-foot"><span>${note?'이 메모는 진행 담당자용으로, 출력하지 않아도 됩니다.':'복사해도 자동으로 다음 이벤트로 넘어가지 않아요.'}</span><span>${chosen?'결과 표시 중':e.kind==='npc'?'화자별 대사':'자유 RP 가능'}</span></footer></article>
  ${e.kind==='npc'&&!chosen?`<div class="play-meta"><label class="toggle-line"><input type="checkbox" id="include-speaker" ${scenario.settings.includeSpeaker?'checked':''}> 화자 이름도 함께 복사하기 <span class="muted">(기본: 대사만)</span></label></div>`:''}
  <div class="character-shortcut"><button type="button" class="btn btn-soft btn-small" data-action="names">✎ KPC·탐사자 이름 변경</button></div>
  <div class="play-actions"><button class="btn" data-action="previous" ${scenario.history.length?'':'disabled'}>‹ 이전</button><button class="btn btn-primary" data-action="copy" ${!body?'disabled':''}>▢ 지문 복사</button><button class="btn" data-action="next" ${canNext?'':'disabled'}>다음 ›</button></div>
  </div><aside class="hint-card"><h3>✳ 플레이 가이드</h3><div class="hint-content">① 지문 복사를 눌러 코코포리아로 붙여넣기<br>② PC·KPC·NPC는 자유롭게 RP<br>③ 원하는 타이밍에 다음 버튼 클릭</div><div class="hint-row"><strong>분기와 판정</strong><p>성공·실패나 엔딩 선택은 여기서 직접 고릅니다. 선택 결과가 있으면 먼저 복사할 수 있어요.</p></div><div class="hint-row"><strong>진행 기록</strong><p>선택과 현재 위치가 이 기기에 자동 저장됩니다. 중요한 시나리오는 JSON 백업을 권장해요.</p></div><button class="linkish" data-action="settings">설정 및 백업 열기 ↗</button></aside></div>`;
}
function renderEditor(){const pos=currentPos();const sceneId=ui.editorSceneId&&scenario.scenes.some(s=>s.id===ui.editorSceneId)?ui.editorSceneId:pos.scene.id;ui.editorSceneId=sceneId;const sc=scenario.scenes.find(s=>s.id===sceneId);
  const selected=sc.entries.find(e=>e.id===ui.editorEntryId)||sc.entries[0];ui.editorEntryId=selected?.id;
  return `<div class="section-top"><div><div class="eyebrow">SCENARIO EDITOR</div><h1 class="page-title">장면과 이벤트 편집</h1><p class="subtle">분석 결과를 자유롭게 고칠 수 있어요. 바뀐 내용은 자동 저장됩니다.</p></div><button class="btn btn-soft btn-small" data-action="play-current">▶ 플레이로</button></div>
  <div class="editor-warning">자동 분석은 초안입니다. 특히 판정 결과, 비밀 정보, 엔딩 연결은 반드시 확인해 주세요.</div>
  <div class="editor-grid"><section class="panel"><div class="form-group"><label class="field-label" for="edit-scene">편집할 장면</label><select class="select" id="edit-scene">${scenario.scenes.map(s=>`<option value="${esc(s.id)}" ${s.id===sc.id?'selected':''}>${esc(personalize(s.title))}</option>`).join('')}</select></div>
  <div class="form-group"><label class="field-label" for="edit-scene-title">장면 제목</label><input class="input" id="edit-scene-title" value="${esc(sc.title)}"></div><div class="editor-actions"><button class="btn btn-small" data-action="add-scene">＋ 장면</button><button class="btn btn-small btn-danger" data-action="delete-scene">장면 삭제</button></div>
  <div class="panel-title" style="margin-top:28px">이벤트 목록 (${sc.entries.length})</div><div class="entry-list">${sc.entries.map((e,i)=>`<button class="entry-link ${e.id===selected?.id?'active':''}" data-action="select-entry" data-id="${esc(e.id)}"><small>${String(i+1).padStart(2,'0')} · ${esc(kinds[e.kind]||'지문')}</small>${esc(personalize((e.title||e.speaker||e.text||'빈 이벤트').slice(0,46)))}</button>`).join('')}</div><div class="editor-actions"><button class="btn btn-soft btn-small" data-action="add-entry">＋ 이벤트 추가</button></div></section>
  <section class="panel">${selected?renderEntryEditor(selected,sc):'<div class="empty">이벤트가 없어요.</div>'}</section></div>`;
}
function renderEntryEditor(e,sc){const optMode=['check','branch'].includes(e.kind);return `<div class="flexrow" style="justify-content:space-between;margin-bottom:16px"><h2 class="panel-title" style="margin:0">✎ 선택한 이벤트</h2><div class="toolbar"><button class="btn btn-small btn-icon" data-action="move-entry-up" title="위로 이동">↑</button><button class="btn btn-small btn-icon" data-action="move-entry-down" title="아래로 이동">↓</button><button class="btn btn-small btn-danger" data-action="delete-entry">삭제</button></div></div>
  <div class="form-group"><label class="field-label" for="edit-kind">종류</label><select class="select" id="edit-kind">${Object.entries(kinds).map(([k,v])=>`<option value="${k}" ${k===e.kind?'selected':''}>${esc(v)}</option>`).join('')}</select></div>
  <div class="form-group"><label class="field-label" for="edit-entry-title">이벤트 제목 (선택)</label><input class="input" id="edit-entry-title" value="${esc(e.title)}" placeholder="예: 관찰력 판정 / 엔딩 A"></div>
  ${e.kind==='npc'?`<div class="form-group"><label class="field-label" for="edit-speaker">NPC 이름</label><input class="input" id="edit-speaker" value="${esc(e.speaker)}" placeholder="예: 집사"></div>`:''}
  <div class="form-group"><label class="field-label" for="edit-entry-text">${e.kind==='note'?'진행 메모':e.kind==='npc'?'NPC 대사':e.kind==='check'?'판정 안내':e.kind==='branch'?'분기 안내':'출력할 지문'}</label><textarea class="textarea" id="edit-entry-text" rows="7" placeholder="여기에 내용을 입력하세요.">${esc(e.text)}</textarea><div class="text-help">줄바꿈 그대로 복사됩니다. 원문 전체와 편집된 이벤트는 별도로 보관돼요.</div></div>
  ${optMode?`<div class="options-editor"><div class="flexrow" style="justify-content:space-between;margin-bottom:12px"><h3 class="panel-title" style="margin:0">${e.kind==='check'?'판정 결과':'분기 선택지'}</h3><button class="btn btn-small btn-soft" data-action="add-option">＋ 선택지</button></div>
  ${e.options.map((o,i)=>`<div class="option-editor"><div class="flexrow" style="justify-content:space-between;margin-bottom:12px"><strong style="font-size:12px">선택지 ${i+1}</strong><button class="btn btn-small btn-danger" data-action="delete-option" data-id="${esc(o.id)}">삭제</button></div>
  <div class="form-group"><label class="field-label">버튼 이름</label><input class="input" data-option-id="${esc(o.id)}" data-option-field="label" value="${esc(o.label)}"></div>
  <div class="form-group"><label class="field-label">결과 지문 (선택 후 복사)</label><textarea class="textarea" data-option-id="${esc(o.id)}" data-option-field="text" rows="3">${esc(o.text)}</textarea></div>
  <div class="form-group" style="margin:0"><label class="field-label">선택 후 이동할 장면</label><select class="select" data-option-id="${esc(o.id)}" data-option-field="targetSceneId"><option value="">다음 이벤트로 계속</option>${scenario.scenes.map(s=>`<option value="${esc(s.id)}" ${s.id===o.targetSceneId?'selected':''}>${esc(personalize(s.title))}</option>`).join('')}</select></div></div>`).join('')||'<p class="subtle">선택지가 없어요. 선택지를 추가하세요.</p>'}</div>`:''}
  <button class="btn btn-soft" data-action="jump-entry" data-id="${esc(e.id)}" style="margin-top:12px">▶ 이 이벤트부터 플레이</button>`;
}
function renderSource(){return `<div class="section-top"><div><div class="eyebrow">ORIGINAL TEXT</div><h1 class="page-title">시나리오 원문 검색</h1><p class="subtle">업로드한 원문은 보존됩니다. 이름 치환 적용 여부를 선택할 수 있어요.</p></div></div>
 <div class="form-group"><label class="toggle-line"><input id="source-transformed" type="checkbox" ${ui.sourceTransformed?'checked':''}> KPC·탐사자 이름 변경 적용해서 보기 / 복사</label></div>
 <div class="source-controls"><input id="source-query" class="input" style="max-width:410px;flex:1" placeholder="검색할 단어 또는 문장" value="${esc(ui.sourceQuery)}"><button class="btn" data-action="source-prev">‹</button><button class="btn" data-action="source-next">›</button><span class="subtle" id="source-count">—</span><button class="btn btn-soft" data-action="copy-source">현재 표시된 원문 복사</button></div>
 <textarea class="source-reader" id="source-reader" readonly spellcheck="false" aria-label="시나리오 원문">${esc(sourceDisplayText()||'등록된 원문이 없어요. 편집 탭에서 직접 작성한 시나리오일 수 있습니다.')}</textarea><p class="subtle">PDF에서 복사 방지가 적용되거나 스캔된 페이지라면 글자를 추출하지 못할 수 있어요.</p>`;}
function setTab(tab){if(!['play','edit','source'].includes(tab))return;ui.tab=tab;render();window.scrollTo({top:0,behavior:'instant'});}
function render(){if(!scenario)return;renderSidebar();$('#view').innerHTML=ui.tab==='play'?renderPlay():ui.tab==='edit'?renderEditor():renderSource();$$('[data-tab]').forEach(el=>{el.classList.toggle('active',el.dataset.tab===ui.tab);if(el.hasAttribute('role'))el.setAttribute('aria-selected',String(el.dataset.tab===ui.tab));});if(ui.tab==='source')searchSource(false);}
function showModal(html,wide=false){$('#modal-root').innerHTML=`<div class="modal-backdrop" id="modal-backdrop"><section class="modal ${wide?'wide':''}" role="dialog" aria-modal="true">${html}</section></div>`;$('#modal-backdrop').addEventListener('click',ev=>{if(ev.target.id==='modal-backdrop')closeModal();});}
function closeModal(){$('#modal-root').innerHTML='';}
function modalHead(title,subtitle=''){return `<div class="modal-head"><div><h2>${esc(title)}</h2>${subtitle?`<p class="subtle">${esc(subtitle)}</p>`:''}</div><button class="btn btn-ghost btn-icon" data-action="close-modal" aria-label="닫기">✕</button></div>`;}
function openImport(){showModal(`${modalHead('새 시나리오 불러오기','원문을 붙여넣거나 TXT · MD · PDF 파일을 선택하세요.')}
  <div class="form-group"><label class="field-label" for="import-name">시나리오 이름</label><input class="input" id="import-name" placeholder="예: 겨울 저택의 비밀" value=""></div>
  <div class="file-area"><p style="font-weight:800;margin:0 0 10px">📄 파일 선택</p><input type="file" id="import-file" accept=".txt,.md,.pdf,.json,text/plain,application/pdf,application/json"><p class="text-help" id="import-file-status">PDF는 최초 이용 시 인터넷 연결이 필요할 수 있어요. JSON은 백업 복원용입니다.</p></div>
  <div class="divider-label">— 또는 아래에 원문 붙여넣기 —</div>
  <div class="form-group"><label class="field-label" for="import-text">시나리오 원문</label><textarea class="textarea" id="import-text" placeholder="# 장면 1\n저택의 문이 열린다.\n집사: 어서 오세요.\n관찰력 판정\n성공: 단서를 발견한다.\n실패: 아무것도 발견하지 못한다.\n\nENDING A\n귀환한다.\nENDING B\n남는다."></textarea></div>
  <p class="subtle"><strong>자동 분할:</strong> <code># 장면 제목</code> · <code>ENDING A</code> · <code>관찰력 판정</code> + <code>성공:</code> / <code>실패:</code>를 인식하며, 일반 지문은 엔터 한 번마다 분리해요. 분석 후 내용을 확인해 주세요.</p>
  <div class="modal-footer"><button class="btn" data-action="close-modal">취소</button><button class="btn btn-primary" id="confirm-import" data-action="import-confirm">분석하고 시작하기</button></div>`,true);}
function openNameSettings(){
  const values=nameMaps();
  showModal(`${modalHead('KPC · 탐사자 이름 일괄 변경','저장한 시나리오의 원문과 편집 내용은 그대로 두고, 표시·복사할 때만 바꿔요.')}
  <div class="name-settings-grid">
    <div class="name-setting-card"><h3>✦ KPC</h3><div class="form-group"><label class="field-label" for="name-kpc-from">원문에서 쓰인 이름·표기</label><input id="name-kpc-from" class="input" value="${esc(values.kpc.from)}" placeholder="KPC, 기존 이름" /></div><div class="form-group"><label class="field-label" for="name-kpc-to">바꿀 이름</label><input id="name-kpc-to" class="input" value="${esc(values.kpc.to)}" placeholder="예: 서윤" /></div></div>
    <div class="name-setting-card"><h3>✦ 탐사자 / PC</h3><div class="form-group"><label class="field-label" for="name-pc-from">원문에서 쓰인 이름·표기</label><input id="name-pc-from" class="input" value="${esc(values.pc.from)}" placeholder="탐사자, PC, 기존 이름" /></div><div class="form-group"><label class="field-label" for="name-pc-to">바꿀 이름</label><input id="name-pc-to" class="input" value="${esc(values.pc.to)}" placeholder="예: 하나" /></div></div>
  </div>
  <p class="text-help">여러 표기는 쉼표로 구분해요. 예: <code>탐사자, PC, 김탐사</code>. 한국어 이름은 받침에 맞게 은/는 · 이/가 · 을/를 · 와/과 · 로/으로 등을 고쳐요. 영어 이름은 발음이 불확실해 원래 조사를 유지해요.</p>
  <div class="name-preview"><div class="field-label">바뀐 지문 미리보기</div><div id="names-preview">${esc(namesExample())}</div></div>
  <p class="text-help">기존 원본 및 JSON 백업은 보존돼요. 플레이 화면, 복사, TXT 내보내기, 원문 미리보기에 적용됩니다. 편집 입력칸에는 원래 내용이 유지돼요.</p>
  <div class="modal-footer"><button class="btn btn-primary" data-action="close-modal">적용하고 닫기</button></div>`,true);
}
function openSettings(){showModal(`${modalHead('설정 · 백업','모든 데이터는 기본적으로 이 기기에 저장됩니다.')}
 <div class="button-row" style="margin-bottom:16px"><button class="btn btn-soft" data-action="install-help">⇩ 웹앱 설치·멀티윈도우 안내</button><button class="btn" data-action="split-toggle">▣ 화면 줄이기/되돌리기</button></div>
 <div class="button-row" style="margin-bottom:16px"><button class="btn btn-primary" data-action="names">✎ KPC·탐사자 이름 바꾸기</button></div>
 <div class="form-group"><label class="field-label" for="setting-title">현재 시나리오 이름</label><input class="input" id="setting-title" value="${esc(scenario.title)}"></div>
 <div class="form-group"><label class="toggle-line"><input id="setting-hide-future" type="checkbox" ${scenario.settings.hideFuture?'checked':''}> 미방문 장면 제목 가리기</label></div>
 <div class="editor-warning">브라우저 데이터 삭제나 기기 변경 시 기록이 사라질 수 있어요. 중요한 시나리오는 JSON 백업을 저장해 주세요.</div>
 <div class="button-row"><button class="btn btn-soft" data-action="reparse-source">↻ 원문을 새 규칙으로 다시 분석</button></div>
 <p class="subtle">기존 시나리오에도 엔터 1번 = 지문 1개 규칙을 적용할 수 있어요. 수정한 이벤트와 현재 진행 기록은 초기화되므로 먼저 JSON 백업을 권장해요.</p>
 <div class="button-row"><button class="btn btn-primary" data-action="export-json">↓ 현재 시나리오 JSON 백업</button><button class="btn" data-action="export-text">↓ 편집 지문 TXT</button></div>
 <div class="modal-footer"><button class="btn btn-danger" data-action="delete-current">현재 시나리오 삭제</button><button class="btn" data-action="close-modal">닫기</button></div>`);}
function openLibrary(){showModal(`${modalHead('내 시나리오','저장된 시나리오를 열거나 새로 만들 수 있어요.')}
 ${[...scenarios].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).map(s=>`<div class="library-item"><div style="min-width:0"><strong>${esc(s.title)} ${scenario.id===s.id?'· 현재 열림':''}</strong><small>${s.scenes.length}개 장면 · ${new Date(s.updatedAt).toLocaleDateString('ko-KR')}</small></div><button class="btn btn-small ${scenario.id===s.id?'btn-soft':'btn-primary'}" data-action="load-scenario" data-id="${esc(s.id)}">열기</button></div>`).join('')}
 <div class="modal-footer"><button class="btn btn-soft" data-action="new-blank">＋ 빈 시나리오</button><button class="btn btn-primary" data-action="import-open">＋ 파일 불러오기</button></div>`);}
function openScenes(){const pos=currentPos();showModal(`${modalHead('장면 이동','선택한 장면의 첫 이벤트로 이동합니다.')}${scenario.scenes.map((s,i)=>{const hidden=scenario.settings.hideFuture&&i>pos.si&&!s.entries.some(e=>scenario.visited.includes(e.id));return `<button class="scene-link ${s.id===pos.scene.id?'current':''}" data-action="jump-scene" data-id="${esc(s.id)}"><span class="scene-num">${String(i+1).padStart(2,'0')}</span><span class="scene-title">${hidden?'🔒 미방문 장면':esc(personalize(s.title))}</span><span class="scene-count">${s.entries.length}개</span></button>`;}).join('')}`);}
function searchSource(focus=true){if(ui.tab!=='source')return;const textarea=$('#source-reader'),query=ui.sourceQuery;if(!textarea)return;const text=sourceDisplayText(),hits=[];if(query){let offset=0;while(hits.length<10000){const at=text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase(),offset);if(at<0)break;hits.push(at);offset=at+Math.max(1,query.length);}}if(!hits.length)ui.sourceMatch=0;else ui.sourceMatch=Math.max(0,Math.min(ui.sourceMatch,hits.length-1));$('#source-count').textContent=query?`${hits.length?ui.sourceMatch+1:0} / ${hits.length}건`:'검색어를 입력하세요';if(hits.length&&focus){textarea.focus();textarea.setSelectionRange(hits[ui.sourceMatch],hits[ui.sourceMatch]+query.length);textarea.blur();}}
function changeEntryField(id,field,value){const pos=findPosition(id);if(!pos)return;pos.entry[field]=value;remember();}
function download(name,content,type='application/json;charset=utf-8'){const blob=new Blob([content],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name.replace(/[\\/:*?"<>|]/g,'_');document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1500);}
function fileTitle(name){return name.replace(/\.(pdf|txt|md|json)$/i,'')||'새 시나리오';}
async function loadPdf(file){
  if(!window.pdfjsLib){
    await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';script.onload=resolve;script.onerror=()=>reject(new Error('PDF 읽기 라이브러리를 불러오지 못했어요. 인터넷 연결을 확인하거나 텍스트를 붙여넣어 주세요.'));document.head.append(script);});
  }
  window.pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const doc=await window.pdfjsLib.getDocument({data:new Uint8Array(await file.arrayBuffer()),isEvalSupported:false}).promise;
  const texts=[];
  for(let pageNo=1;pageNo<=doc.numPages;pageNo++){
    const page=await doc.getPage(pageNo);const content=await page.getTextContent();
    let rows=[],lastY=null,row=[];
    const flushRow=()=>{if(row.length){rows.push(row.join(' ').replace(/\s+/g,' ').trim());row=[];}};
    for(const item of content.items){if(!item.str)continue;const y=item.transform?.[5]??0;if(lastY!==null&&Math.abs(y-lastY)>3)flushRow();row.push(item.str);lastY=y;if(item.hasEOL){flushRow();lastY=null;}}
    flushRow();texts.push(`\n\n[PDF ${pageNo}쪽]\n`+rows.join('\n'));
  }
  return texts.join('\n').trim();
}
async function readImportFile(file){if(file.size>25*1024*1024)throw new Error('파일은 25MB 이하만 지원합니다.');const lower=file.name.toLowerCase();if(lower.endsWith('.pdf')||file.type==='application/pdf')return await loadPdf(file);return await file.text();}
async function activate(newScenario){await saveNow();scenario=newScenario;const found=scenarios.findIndex(x=>x.id===scenario.id);if(found<0)scenarios.push(scenario);else scenarios[found]=scenario;safeSet('sf-current',scenario.id);ui.editorEntryId=null;ui.editorSceneId=null;ui.sourceQuery='';ui.tab='play';if(!scenario.visited.includes(scenario.current.entryId))scenario.visited.push(scenario.current.entryId);await storage.put(scenario);closeModal();render();window.scrollTo({top:0});}
async function onImportConfirm(){const raw=$('#import-text')?.value.trim(),file=$('#import-file')?.files?.[0],name=$('#import-name')?.value.trim()||fileTitle(file?.name||'새 시나리오');const btn=$('#confirm-import');btn.disabled=true;btn.textContent='분석 중…';try{
  if(file?.name.toLowerCase().endsWith('.json')){const data=JSON.parse(raw||await file.text());await activate(normalizeImported(data.scenario||data));toast('백업 시나리오를 복원했어요.');return;}
  let text=raw;if(!text&&file)text=await readImportFile(file);if(!text.trim())throw new Error('원문을 입력하거나 파일을 선택해 주세요.');
  if(file?.name.toLowerCase().endsWith('.pdf')&&text.trim().length<40)throw new Error('PDF에서 글자를 추출하지 못했어요. 스캔본이면 OCR로 텍스트를 만든 뒤 붙여넣어 주세요.');
  const parsed=parseSource(text,name);await activate(parsed);toast(`장면 ${parsed.scenes.length}개, 이벤트 ${parsed.scenes.reduce((s,c)=>s+c.entries.length,0)}개를 정리했어요.`);
}catch(err){toast(err.message||'불러오기에 실패했어요.');if(btn){btn.disabled=false;btn.textContent='분석하고 시작하기';}}}
async function switchScenario(id){const target=scenarios.find(s=>s.id===id);if(target){await activate(target);toast('시나리오를 열었어요.');}}
async function removeCurrent(){if(!confirm(`'${scenario.title}' 시나리오를 삭제할까요? 이 작업은 되돌릴 수 없어요.`))return;const old=scenario.id;clearTimeout(saveTimer);await storage.del(old);scenarios=scenarios.filter(s=>s.id!==old);if(!scenarios.length){const fresh=demo();scenarios.push(fresh);}scenario=null;await activate(scenarios[0]);toast('삭제했어요.');}
function selectedEditor(){const sc=scenario.scenes.find(x=>x.id===ui.editorSceneId)||currentPos().scene;return {sc,e:sc.entries.find(x=>x.id===ui.editorEntryId)||sc.entries[0]};}
async function doAction(action,id){const pos=currentPos();switch(action){
  case 'install-help':openInstallHelp();break;
  case 'install-now':await installNow();break;
  case 'split-toggle':toggleSplitMode();break;
  case 'split-auto':resetSplitAuto();break;
  case 'copy':await copyToClipboard(copyTextForCurrent());break;
  case 'copy-source':await copyToClipboard(sourceDisplayText());break;
  case 'names':openNameSettings();break;
  case 'next':advance();break;
  case 'previous':prev();break;
  case 'choose':chooseOption(id);break;
  case 'jump-scene':{const sc=scenario.scenes.find(s=>s.id===id);if(sc?.entries[0]){closeModal();goTo(sc.entries[0].id);}break;}
  case 'jump-entry':closeModal();goTo(id);setTab('play');break;
  case 'play-current':setTab('play');break;
  case 'library':openLibrary();break;
  case 'settings':openSettings();break;
  case 'close-modal':closeModal();break;
  case 'import-open':openImport();break;
  case 'import-confirm':await onImportConfirm();break;
  case 'load-scenario':await switchScenario(id);break;
  case 'new-blank':await activate(wrapScenario('새 시나리오','',[sceneObj('도입',[entry('text','')])]));toast('새 시나리오를 만들었어요.');break;
  case 'reparse-source':{if(!scenario.source?.trim()){toast('저장된 원문이 없어요.');break;}if(!confirm('원문을 다시 분석할까요? 기존 이벤트 수정과 진행 기록이 초기화됩니다. 중요한 시나리오는 먼저 JSON 백업을 저장하세요.'))break;const fresh=parseSource(scenario.source,scenario.title);scenario.scenes=fresh.scenes;scenario.current=fresh.current;scenario.history=[];scenario.visited=[scenario.current.entryId];ui.editorSceneId=null;ui.editorEntryId=null;remember();closeModal();render();toast('새 규칙으로 다시 분석했어요.');break;}
  case 'export-json':download(`${scenario.title}.json`,JSON.stringify({sceneflow:1,exportedAt:stamp(),scenario},null,2));toast('JSON 백업을 저장했어요.');break;
  case 'export-text':download(`${scenario.title}-지문.txt`,personalize(scenario.scenes.map(sc=>`# ${sc.title}\n\n`+sc.entries.map(e=>`${e.kind==='npc'?`${e.speaker}: `:e.kind==='ending'?'[엔딩] ':e.kind==='note'?'[메모] ':''}${e.text}${e.options.length?'\n'+e.options.map(o=>`[${o.label}] ${o.text}`).join('\n'):''}`).join('\n\n')).join('\n\n')), 'text/plain;charset=utf-8');toast('편집된 지문을 TXT로 저장했어요.');break;
  case 'delete-current':await removeCurrent();break;
  case 'select-entry':ui.editorEntryId=id;render();break;
  case 'add-scene':{const sc=sceneObj(`새 장면 ${scenario.scenes.length+1}`);scenario.scenes.push(sc);ui.editorSceneId=sc.id;ui.editorEntryId=sc.entries[0].id;remember();render();break;}
  case 'delete-scene':{const {sc}=selectedEditor();if(scenario.scenes.length<=1){toast('장면을 하나 이상 남겨 주세요.');break;}if(!confirm(`'${sc.title}' 장면을 삭제할까요?`))break;scenario.scenes=scenario.scenes.filter(s=>s.id!==sc.id);for(const s of scenario.scenes)for(const e of s.entries)for(const o of e.options)if(o.targetSceneId===sc.id)o.targetSceneId='';if(sc.entries.some(e=>e.id===scenario.current.entryId))scenario.current={entryId:scenario.scenes[0].entries[0].id,pendingOptionId:null};ui.editorSceneId=scenario.scenes[0].id;ui.editorEntryId=null;remember();render();break;}
  case 'add-entry':{const {sc}=selectedEditor();const e=entry('text','');sc.entries.push(e);ui.editorEntryId=e.id;remember();render();break;}
  case 'delete-entry':{const {sc,e}=selectedEditor();if(sc.entries.length<=1){toast('장면마다 이벤트를 하나 이상 남겨 주세요.');break;}if(!confirm('이 이벤트를 삭제할까요?'))break;sc.entries=sc.entries.filter(x=>x.id!==e.id);if(scenario.current.entryId===e.id)scenario.current={entryId:sc.entries[0].id,pendingOptionId:null};ui.editorEntryId=sc.entries[0].id;remember();render();break;}
  case 'move-entry-up':case 'move-entry-down':{const {sc,e}=selectedEditor();const from=sc.entries.findIndex(x=>x.id===e.id);const to=from+(action==='move-entry-up'?-1:1);if(to>=0&&to<sc.entries.length){[sc.entries[from],sc.entries[to]]=[sc.entries[to],sc.entries[from]];remember();render();}break;}
  case 'add-option':{const {e}=selectedEditor();e.options.push(option(`선택지 ${e.options.length+1}`));remember();render();break;}
  case 'delete-option':{const {e}=selectedEditor();e.options=e.options.filter(o=>o.id!==id);if(scenario.current.entryId===e.id&&scenario.current.pendingOptionId===id)scenario.current.pendingOptionId=null;remember();render();break;}
  case 'source-prev':ui.sourceMatch=Math.max(0,ui.sourceMatch-1);searchSource();break;
  case 'source-next':ui.sourceMatch++;searchSource();break;
}}
function attachHandlers(){
  document.addEventListener('click',async ev=>{
    const tab=ev.target.closest('[data-tab]');if(tab){setTab(tab.dataset.tab);return;}
    const control=ev.target.closest('[data-action]');if(control){await doAction(control.dataset.action,control.dataset.id);return;}
  });
  $('#toggle-split').addEventListener('click',toggleSplitMode);
  $('#open-import').addEventListener('click',openImport);
  $('#open-library').addEventListener('click',openLibrary);
  $('#open-settings').addEventListener('click',openSettings);
  $('#mobile-scenes').addEventListener('click',openScenes);
  document.addEventListener('input',ev=>{
    const t=ev.target;
    if(t.id==='edit-scene-title'){const s=scenario.scenes.find(s=>s.id===ui.editorSceneId);if(s){s.title=t.value;remember();}return;}
    if(t.id==='edit-entry-title'||t.id==='edit-entry-text'||t.id==='edit-speaker'){const {e}=selectedEditor();e[{ 'edit-entry-title':'title','edit-entry-text':'text','edit-speaker':'speaker'}[t.id]]=t.value;remember();return;}
    if(t.dataset.optionId&&['label','text'].includes(t.dataset.optionField)){const {e}=selectedEditor();const o=e.options.find(o=>o.id===t.dataset.optionId);if(o){o[t.dataset.optionField]=t.value;remember();}return;}
    if(t.id==='setting-title'){scenario.title=t.value||'제목 없는 시나리오';remember();renderSidebar();return;}
    const nameId=t.id.match(/^name-(kpc|pc)-(from|to)$/);
    if(nameId){scenario.settings.nameMappings??={};const role=nameId[1];scenario.settings.nameMappings[role]={...nameMaps()[role],[nameId[2]]:t.value};remember();render();const preview=$('#names-preview');if(preview)preview.textContent=namesExample();return;}
    if(t.id==='source-query'){ui.sourceQuery=t.value;ui.sourceMatch=0;searchSource();return;}
    if(t.id==='import-file'){const file=t.files?.[0];if(file){const name=$('#import-name');if(name&&!name.value)name.value=fileTitle(file.name);$('#import-file-status').textContent=`선택됨: ${file.name} (${Math.round(file.size/1024)}KB)`;}return;}
  });
  document.addEventListener('change',ev=>{
    const t=ev.target;
    if(t.id==='include-speaker'){scenario.settings.includeSpeaker=t.checked;remember();return;}
    if(t.id==='setting-hide-future'){scenario.settings.hideFuture=t.checked;remember();renderSidebar();return;}
    if(t.id==='source-transformed'){ui.sourceTransformed=t.checked;ui.sourceMatch=0;render();return;}
    if(t.id==='edit-scene'){ui.editorSceneId=t.value;ui.editorEntryId=null;render();return;}
    if(t.id==='edit-kind'){const {e}=selectedEditor();e.kind=t.value;if(['check','branch'].includes(e.kind)&&!e.options.length)e.options=e.kind==='check'?[option('성공'),option('실패')]:[option('선택지 A'),option('선택지 B')];remember();render();return;}
    if(t.dataset.optionId&&t.dataset.optionField==='targetSceneId'){const {e}=selectedEditor();const o=e.options.find(o=>o.id===t.dataset.optionId);if(o){o.targetSceneId=t.value;remember();}return;}
  });
  document.addEventListener('keydown',ev=>{
    if(ev.key==='Escape'&&$('#modal-backdrop'))closeModal();
    if($('#modal-backdrop')||/^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName)||ev.target.isContentEditable)return;
    if((ev.ctrlKey||ev.metaKey)&&ev.key==='Enter'){ev.preventDefault();copyToClipboard(copyTextForCurrent());}
    else if(ev.key==='ArrowRight'&&ui.tab==='play'){ev.preventDefault();advance();}
    else if(ev.key==='ArrowLeft'&&ui.tab==='play'){ev.preventDefault();prev();}
  });
}
async function start(){attachHandlers();applyWindowMode();window.addEventListener('resize',applyWindowMode);window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredInstallPrompt=e;});window.addEventListener('appinstalled',()=>{deferredInstallPrompt=null;toast('씬플로우가 홈 화면에 설치됐어요!');});scenarios=await storage.all();scenarios=scenarios.filter(s=>s?.scenes?.length);if(!scenarios.length){scenario=demo();scenarios=[scenario];await storage.put(scenario);}else{scenario=scenarios.find(s=>s.id===safeGet('sf-current'))||scenarios[0];}
  scenario.settings={includeSpeaker:false,hideFuture:true,...scenario.settings};scenario.current??={entryId:scenario.scenes[0].entries[0].id,pendingOptionId:null};scenario.history=Array.isArray(scenario.history)?scenario.history:[];scenario.visited=Array.isArray(scenario.visited)?scenario.visited:[];if(!scenario.visited.includes(scenario.current.entryId))scenario.visited.push(scenario.current.entryId);render();
  if('serviceWorker' in navigator&&(location.protocol==='https:'||location.hostname==='localhost'||location.hostname==='127.0.0.1'))navigator.serviceWorker.register('./sw.js').catch(()=>{});
}
start().catch(err=>{$('#view').innerHTML=`<div class="empty">시작할 수 없어요. 브라우저를 새로고침해 주세요.<p>${esc(err.message)}</p></div>`;});
