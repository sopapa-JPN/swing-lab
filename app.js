const $ = id => document.getElementById(id);
const video = $('video');
const canvas = $('canvas');
const ctx = canvas.getContext('2d');

const joints = [11,12,13,14,15,16,23,24,25,26,27,28,31,32];
const edges = [[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],[23,25],[25,27],[27,31],[24,26],[26,28],[28,32]];

let media = null;
let image = null;
let url = null;
let mode = 'overlay';
let editing = false;
let picking = false;
let target = null;
let busy = false;
let cancelled = false;
let recording = false;
let recorder = null;
let pose = [];
let marks = { tip: [], hand: [] };
let corrections = {};
let history = [];

const colors = { tip: '#ff6678', hand: '#50d6ff' };
const now = () => media?.kind === 'image' ? 0 : video.currentTime;
const timekey = t => Math.round(t * 1000);
const status = s => $('status').textContent = s;

function state(){
  return { version: 2, media, marks, pose, corrections, target };
}

function remember(){
  history.push(JSON.stringify({ marks, corrections }));
  if(history.length > 100) history.shift();
  $('undo').disabled = false;
}

function buttons(){
  const loaded = !!media;
  for(const id of ['person','analyze','mark','missing','snapshot','save']){
    $(id).disabled = !loaded || busy || recording;
  }
  for(const id of ['play','back','next','seek']){
    $(id).disabled = !loaded || media.kind === 'image' || busy || recording;
  }
  const canRecord = !!window.MediaRecorder && typeof canvas.captureStream === 'function';
  $('record').disabled = !loaded || media.kind === 'image' || busy || recording || !canRecord;
  $('track-tip').disabled = !loaded || media.kind === 'image' || busy || recording || !marks.tip.some(x => x.p);
  $('file').disabled = busy || recording;
  $('empty-file').disabled = busy || recording;
  $('load').disabled = !loaded || busy || recording;
  $('from').disabled = $('to').disabled = media?.kind === 'image' || busy || recording;
  $('speed').disabled = busy || recording;
  $('undo').disabled = !history.length || busy || recording;
}

function counts(){
  const tipCount = marks.tip.filter(x => x.p).length;
  const autoCount = marks.tip.filter(x => x.p && x.source === 'auto').length;
  $('counts').textContent = `先端 ${tipCount}点（自動 ${autoCount}） / 手元 ${marks.hand.filter(x => x.p).length}点`;
}

async function openFile(file){
  if(!file || busy || recording) return;
  video.pause();
  if(url) URL.revokeObjectURL(url);
  url = URL.createObjectURL(file);
  media = null;
  pose = [];
  marks = { tip: [], hand: [] };
  corrections = {};
  history = [];
  target = null;
  editing = picking = false;
  setEditUI();
  image = null;
  buttons();
  try{
    let w, h, d, kind;
    if(file.type.startsWith('image/')){
      image = new Image();
      image.src = url;
      await image.decode();
      w = image.naturalWidth;
      h = image.naturalHeight;
      d = 0;
      kind = 'image';
    }else{
      await new Promise((resolve,reject) => {
        video.onloadeddata = resolve;
        video.onerror = () => reject(new Error('この動画形式は再生できません。H.264のMP4でお試しください。'));
        video.src = url;
        video.load();
      });
      w = video.videoWidth;
      h = video.videoHeight;
      d = video.duration;
      kind = 'video';
      if(!Number.isFinite(d)) throw new Error('動画の長さを取得できませんでした。');
    }
    media = { name:file.name, width:w, height:h, duration:d, kind };
    const scale = Math.min(1, 1280 / Math.max(w,h));
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    $('filename').textContent = file.name;
    $('empty').hidden = true;
    $('seek').max = d || 1;
    $('seek').value = 0;
    $('from').value = 0;
    $('to').value = Math.min(15,d).toFixed(1);
    $('from').disabled = $('to').disabled = kind === 'image';
    buttons();
    counts();
    draw();
    status('まず骨格を検出し、スイング開始付近でバット先端を1回タップすると自動追跡できます。');
  }catch(e){
    media = null;
    image = null;
    $('empty').hidden = false;
    buttons();
    status(e.message);
  }
}

function bindMediaPicker(buttonId,inputId){
  const button=$(buttonId), input=$(inputId);
  button.addEventListener('click',()=>{
    if(busy||recording)return;
    input.value='';
    input.click();
  });
  input.addEventListener('change',async e=>{
    const file=e.target.files?.[0];
    if(file) await openFile(file);
  });
}
bindMediaPicker('choose-media','file');
bindMediaPicker('choose-media-empty','empty-file');

function nearestPose(t){
  let lo = 0, hi = pose.length;
  while(lo < hi){
    const m = (lo + hi) >> 1;
    if(pose[m].t < t) lo = m + 1; else hi = m;
  }
  let best = null, dist = .16;
  for(const i of [lo-1,lo]){
    const item = pose[i];
    if(item && Math.abs(item.t - t) < dist){
      dist = Math.abs(item.t - t);
      best = item;
    }
  }
  return { ...(best?.points || {}), ...(corrections[timekey(t)] || {}) };
}

function interpolate(list,t){
  if(!list.length) return null;
  const exact = list.find(x => Math.abs(x.t - t) < .018);
  if(exact) return exact.p;
  let a = null, b = null;
  for(const item of list){
    if(item.t < t) a = item; else { b = item; break; }
  }
  if(!a || !b || !a.p || !b.p || b.t - a.t > .501) return null;
  const k = (t - a.t) / (b.t - a.t);
  return { x:a.p.x + (b.p.x-a.p.x)*k, y:a.p.y + (b.p.y-a.p.y)*k };
}

function handAt(t){
  const explicit = marks.hand.find(x => Math.abs(x.t-t) < .018);
  if(explicit) return explicit.p;
  const manual = interpolate(marks.hand,t);
  if(manual) return manual;
  const p = nearestPose(t);
  return p[15] && p[16] ? { x:(p[15].x+p[16].x)/2, y:(p[15].y+p[16].y)/2 } : null;
}

const xy = p => [p.x * canvas.width, p.y * canvas.height];
function line(a,b,color,width=2){
  ctx.beginPath();
  ctx.moveTo(...xy(a));
  ctx.lineTo(...xy(b));
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}
function dot(p,color,r=5){
  ctx.beginPath();
  ctx.arc(...xy(p), r, 0, Math.PI*2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = '#efffff';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}
function grid(){
  ctx.fillStyle = '#071b36';
  ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.strokeStyle = '#183654';
  ctx.lineWidth = 1;
  for(let x=0;x<canvas.width;x+=canvas.width/12){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,canvas.height);ctx.stroke();}
  for(let y=0;y<canvas.height;y+=canvas.height/16){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(canvas.width,y);ctx.stroke();}
}

function drawHud(t){
  if(!$('show-hud')?.checked || mode === 'original') return;
  const w = canvas.width, h = canvas.height;
  const s = Math.max(.72, Math.min(1.35, w/720));
  const topH = 78*s, bottomH = 104*s;
  ctx.save();
  ctx.fillStyle = 'rgba(4,14,25,.78)';
  ctx.fillRect(0,0,w,topH);
  ctx.fillRect(0,h-bottomH,w,bottomH);
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#f5fbff';
  ctx.font = `700 ${18*s}px system-ui, sans-serif`;
  ctx.fillText('スイング軌道｜スイング面表示', 18*s, 24*s);
  ctx.font = `500 ${13*s}px system-ui, sans-serif`;
  ctx.strokeStyle = colors.tip; ctx.lineWidth = 3*s; ctx.beginPath(); ctx.moveTo(20*s,51*s); ctx.lineTo(55*s,51*s); ctx.stroke();
  ctx.fillStyle = '#f5fbff'; ctx.fillText('バット先端', 64*s, 51*s);
  ctx.strokeStyle = colors.hand; ctx.beginPath(); ctx.moveTo(165*s,51*s); ctx.lineTo(200*s,51*s); ctx.stroke();
  ctx.fillStyle = '#f5fbff'; ctx.fillText('手元（グリップ付近）', 209*s, 51*s);

  const y0 = h-bottomH+21*s;
  ctx.font = `600 ${13*s}px system-ui, sans-serif`;
  ctx.fillStyle = '#eaf3fb';
  ctx.fillText(`動画内時刻 ${t.toFixed(2)} 秒 / ${(media?.duration||0).toFixed(2)} 秒`, 18*s, y0);
  ctx.font = `500 ${11*s}px system-ui, sans-serif`;
  ctx.fillStyle = '#cbd8e7';
  ctx.fillText('赤色の線：バット先端　水色の線：手元の軌跡', 18*s, y0+23*s);
  ctx.fillText('黄色面：手元～先端で構成した2Dスイング面', 18*s, y0+43*s);
  ctx.fillText('画面上の2次元表示（3次元復元ではありません）', 18*s, y0+63*s);
  ctx.restore();
}

function draw(){
  if(!media){ grid(); return; }
  const t = now(), w = canvas.width, h = canvas.height;
  ctx.clearRect(0,0,w,h);
  if(mode === 'markers') grid();
  else if(image) ctx.drawImage(image,0,0,w,h);
  else if(video.readyState >= 2) ctx.drawImage(video,0,0,w,h);

  if(mode !== 'original'){
    const start = Math.max(0, Number($('from').value)||0);
    const stop = Math.min(t, Number($('to').value)||t);
    const samples = [];
    const step = .025;
    for(let s=start;s<=stop+.001;s+=step) samples.push({ tip:interpolate(marks.tip,s), hand:handAt(s) });
    if(t>=start && t<=stop+.05) samples.push({ tip:interpolate(marks.tip,t), hand:handAt(t) });

    if($('show-ribbon').checked){
      ctx.fillStyle = 'rgba(255,213,119,.17)';
      for(let i=1;i<samples.length;i++){
        const a=samples[i-1], b=samples[i];
        if(a.tip&&a.hand&&b.tip&&b.hand){
          ctx.beginPath();
          ctx.moveTo(...xy(a.hand));
          ctx.lineTo(...xy(a.tip));
          ctx.lineTo(...xy(b.tip));
          ctx.lineTo(...xy(b.hand));
          ctx.closePath();
          ctx.fill();
          if(i%4===0) line(b.hand,b.tip,'rgba(255,231,164,.46)',1);
        }
      }
    }

    for(const name of ['tip','hand']) if($('show-'+name).checked){
      for(let i=1;i<samples.length;i++) if(samples[i-1][name]&&samples[i][name]) line(samples[i-1][name],samples[i][name],colors[name],3);
      const p = name==='tip' ? interpolate(marks.tip,t) : handAt(t);
      if(p) dot(p,colors[name],6);
    }

    const currentTip = interpolate(marks.tip,t);
    const currentHand = handAt(t);
    if($('show-ribbon').checked && currentTip && currentHand){
      line(currentHand,currentTip,'rgba(255,220,112,.9)',Math.max(2.2,w/300));
    }

    if($('show-pose').checked){
      const pts=nearestPose(t);
      for(const [a,b] of edges) if(pts[a]&&pts[b]) line(pts[a],pts[b],'#5ce4c0',Math.max(3,w/180));
      for(const id of joints) if(pts[id]) dot(pts[id],'#acffe8',Math.max(4,w/140));
    }
  }

  if(picking && target) dot(target,'#ffd477',10);
  drawHud(t);
  $('seek').value = t;
  $('time').textContent = `${t.toFixed(2)} / ${media.duration.toFixed(2)}`;
}

function setView(next){
  if(!['overlay','original','markers'].includes(next)) throw new Error('不明な表示モードです');
  mode = next;
  document.querySelectorAll('[data-view]').forEach(b => {
    b.classList.toggle('active',b.dataset.view===mode);
    b.setAttribute('aria-pressed',String(b.dataset.view===mode));
  });
  draw();
}

document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => setView(b.dataset.view));
for(const id of ['show-tip','show-hand','show-ribbon','show-pose','show-hud']) $(id).onchange = draw;

$('play').onclick = () => { if(video.paused) video.play().catch(e=>status(e.message)); else video.pause(); };
video.onplay = () => $('play').textContent='一時停止';
video.onpause = () => $('play').textContent='再生';
video.ontimeupdate = draw;
video.onseeked = draw;
$('speed').onchange = () => { video.playbackRate=Number($('speed').value); };
$('seek').oninput = () => { video.pause(); video.currentTime=Number($('seek').value); };
for(const [id,delta] of [['back',-.1],['next',.1]]) $(id).onclick = () => { video.pause(); video.currentTime=Math.min(media.duration,Math.max(0,now()+delta)); };
function tick(){ if(!video.paused) draw(); requestAnimationFrame(tick); }
tick();

function setEditUI(){
  $('mark').classList.toggle('active',editing);
  $('mark').textContent = editing ? '指定中：映像をタップ（再押下で終了）' : '映像をタップして指定・補正';
  $('person').classList.toggle('active',picking);
  canvas.style.cursor = editing||picking ? 'crosshair' : 'default';
}

$('mark').onclick = () => {
  editing=!editing;
  picking=false;
  video.pause();
  if(editing) setView('overlay');
  setEditUI();
};
$('person').onclick = () => {
  picking=!picking;
  editing=false;
  video.pause();
  if(picking){ setView('overlay'); status('打者の腰の中央付近をタップしてください。'); }
  setEditUI();
};

function put(p){
  remember();
  const t=now(), key=$('point').value;
  if(key==='tip'||key==='hand'){
    marks[key]=marks[key].filter(x=>Math.abs(x.t-t)>.018);
    marks[key].push({t,p,source:'manual'});
    marks[key].sort((a,b)=>a.t-b.t);
  }else{
    const k=timekey(t);
    corrections[k]??={};
    corrections[k][key]=p;
  }
  counts();
  buttons();
  draw();
  status(p ? '位置を記録しました。自動追跡が外れた場所の補正点としても使えます。' : 'この時刻を欠測として記録しました。');
}

canvas.onclick = e => {
  if(!media||busy||recording) return;
  const r=canvas.getBoundingClientRect();
  const p={x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))};
  if(picking){
    target=p; picking=false; setEditUI();
    status('打者を選択しました。「骨格を自動検出」を押してください。');
    draw();
  }else if(editing) put(p);
};
$('missing').onclick = () => put(null);
$('undo').onclick = () => {
  const previous=history.pop();
  if(previous){
    const d=JSON.parse(previous);
    marks=d.marks;
    corrections=d.corrections;
    counts(); draw(); buttons();
  }
};

function seekTo(t){
  return new Promise((resolve,reject) => {
    if(Math.abs(video.currentTime-t)<.0001 && video.readyState>=2) return resolve();
    const timer=setTimeout(()=>{video.removeEventListener('seeked',done);reject(new Error('動画の読み取りがタイムアウトしました。'));},15000);
    function done(){clearTimeout(timer);resolve();}
    video.addEventListener('seeked',done,{once:true});
    video.currentTime=t;
  });
}

function interval(){
  const a=Number($('from').value), b=Number($('to').value);
  if(!Number.isFinite(a)||!Number.isFinite(b)||a<0||b<=a||b>media.duration+.1||b-a>60) throw new Error('開始・終了を動画の範囲内で指定してください。1回の解析は60秒以内です。');
  return [a,Math.min(b,media.duration)];
}

$('cancel').onclick = () => { cancelled=true; };

$('analyze').onclick = async () => {
  if(!media||busy) return;
  let detector;
  const original=now();
  try{
    const [a,b]=media.kind==='image'?[0,0]:interval();
    busy=true; cancelled=false; video.pause(); editing=picking=false; setEditUI(); buttons();
    $('cancel').hidden=false; $('progress').hidden=false; $('progress').value=0;
    status('骨格検出モデルを読み込んでいます…');
    const {FilesetResolver,PoseLandmarker}=await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/vision_bundle.mjs');
    const files=await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/wasm');
    detector=await PoseLandmarker.createFromOptions(files,{
      baseOptions:{modelAssetPath:'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task'},
      runningMode:media.kind==='image'?'IMAGE':'VIDEO',numPoses:3,minPoseDetectionConfidence:.4,minPosePresenceConfidence:.4,minTrackingConfidence:.4
    });
    let anchor=target, found=0;
    const total=media.kind==='image'?1:Math.ceil((b-a)*10)+1;
    let processed=0;
    for(let i=0;i<total&&!cancelled;i++){
      const t=media.kind==='image'?0:Math.min(b-.001,a+i*.1);
      if(!image) await seekTo(Math.max(0,t));
      const result=image?detector.detect(image):detector.detectForVideo(video,i*100+1);
      let candidates=result.landmarks||[];
      const center=p=>({x:(p[23].x+p[24].x)/2,y:(p[23].y+p[24].y)/2});
      if(anchor) candidates.sort((a,b)=>{const x=center(a),y=center(b);return Math.hypot(x.x-anchor.x,x.y-anchor.y)-Math.hypot(y.x-anchor.x,y.y-anchor.y);});
      else candidates.sort((a,b)=>Math.abs(b[11].y-b[27].y)-Math.abs(a[11].y-a[27].y));
      const selected=candidates[0], pts={};
      if(selected){
        const c=center(selected);
        if(!anchor||Math.hypot(c.x-anchor.x,c.y-anchor.y)<.28){
          for(const id of joints){ const p=selected[id]; if((p.visibility??1)>.45) pts[id]={x:p.x,y:p.y}; }
          anchor=c; found++;
        }
      }
      pose=pose.filter(x=>Math.abs(x.t-t)>.035);
      pose.push({t,points:pts}); pose.sort((a,b)=>a.t-b.t);
      processed++; $('progress').value=processed/total;
      status(`骨格を検出中 ${Math.round(processed/total*100)}%`);
      draw(); await new Promise(r=>setTimeout(r,0));
    }
    pose.sort((a,b)=>a.t-b.t);
    status(`${cancelled?'検出を中止しました。':'検出が完了しました。'} ${processed}枚中${found}枚で人物を検出。次にバット先端を1回指定して自動追跡してください。`);
  }catch(e){
    console.error(e);
    status('検出できませんでした。'+e.message+' 手動でマーカーを指定することもできます。');
  }finally{
    detector?.close(); busy=false; $('cancel').hidden=true; $('progress').hidden=true;
    if(media?.kind==='video') await seekTo(original).catch(()=>{});
    buttons(); draw();
  }
};

// ===== Auto bat-tip tracker =====
const trackCanvas=document.createElement('canvas');
const trackCtx=trackCanvas.getContext('2d',{willReadFrequently:true});

function captureTrackFrame(){
  const maxDim=560;
  const sc=Math.min(1,maxDim/Math.max(media.width,media.height));
  const w=Math.max(2,Math.round(media.width*sc));
  const h=Math.max(2,Math.round(media.height*sc));
  if(trackCanvas.width!==w||trackCanvas.height!==h){trackCanvas.width=w;trackCanvas.height=h;}
  trackCtx.drawImage(video,0,0,w,h);
  const rgba=trackCtx.getImageData(0,0,w,h).data;
  const gray=new Uint8Array(w*h);
  for(let i=0,j=0;i<rgba.length;i+=4,j++) gray[j]=(rgba[i]*77+rgba[i+1]*150+rgba[i+2]*29)>>8;
  return {gray,w,h};
}

function makePatch(frame,p,r=7,step=2){
  const vals=[];
  const cx=Math.round(p.x), cy=Math.round(p.y);
  for(let dy=-r;dy<=r;dy+=step){
    for(let dx=-r;dx<=r;dx+=step){
      const x=Math.max(1,Math.min(frame.w-2,cx+dx));
      const y=Math.max(1,Math.min(frame.h-2,cy+dy));
      vals.push(frame.gray[y*frame.w+x]);
    }
  }
  let mean=0; for(const v of vals) mean+=v; mean/=vals.length;
  let norm=0; const centered=new Float32Array(vals.length);
  for(let i=0;i<vals.length;i++){ const v=vals[i]-mean; centered[i]=v; norm+=v*v; }
  return {v:centered,norm:Math.sqrt(norm)+1e-6,r,step};
}

function patchCorr(template,frame,x,y){
  let mean=0,n=0;
  for(let dy=-template.r;dy<=template.r;dy+=template.step){
    for(let dx=-template.r;dx<=template.r;dx+=template.step){
      const xx=Math.max(1,Math.min(frame.w-2,Math.round(x+dx)));
      const yy=Math.max(1,Math.min(frame.h-2,Math.round(y+dy)));
      mean+=frame.gray[yy*frame.w+xx]; n++;
    }
  }
  mean/=n;
  let dotp=0,norm=0,k=0;
  for(let dy=-template.r;dy<=template.r;dy+=template.step){
    for(let dx=-template.r;dx<=template.r;dx+=template.step){
      const xx=Math.max(1,Math.min(frame.w-2,Math.round(x+dx)));
      const yy=Math.max(1,Math.min(frame.h-2,Math.round(y+dy)));
      const v=frame.gray[yy*frame.w+xx]-mean;
      dotp+=template.v[k++]*v; norm+=v*v;
    }
  }
  return dotp/(template.norm*(Math.sqrt(norm)+1e-6));
}

function localMotion(prev,curr,x,y){
  const xx=Math.max(1,Math.min(curr.w-2,Math.round(x))), yy=Math.max(1,Math.min(curr.h-2,Math.round(y)));
  let sum=0,n=0;
  for(let dy=-3;dy<=3;dy+=3) for(let dx=-3;dx<=3;dx+=3){
    const px=Math.max(1,Math.min(curr.w-2,xx+dx)), py=Math.max(1,Math.min(curr.h-2,yy+dy));
    sum+=Math.abs(curr.gray[py*curr.w+px]-prev.gray[py*prev.w+px]); n++;
  }
  return Math.min(1,sum/(n*80));
}

function localEdge(frame,x,y){
  const xx=Math.max(1,Math.min(frame.w-2,Math.round(x))), yy=Math.max(1,Math.min(frame.h-2,Math.round(y)));
  const g=frame.gray,w=frame.w;
  const gx=Math.abs(g[yy*w+xx+1]-g[yy*w+xx-1]);
  const gy=Math.abs(g[(yy+1)*w+xx]-g[(yy-1)*w+xx]);
  return Math.min(1,(gx+gy)/180);
}

function nearestManualTip(t,tol=.022){
  let best=null,dist=tol;
  for(const m of marks.tip){
    if(!m.p || m.source==='auto') continue;
    const d=Math.abs(m.t-t); if(d<dist){dist=d;best=m;}
  }
  return best;
}

function normToTrack(p,frame){return{x:p.x*frame.w,y:p.y*frame.h};}
function trackToNorm(p,frame){return{x:p.x/frame.w,y:p.y/frame.h};}
function clamp(v,a,b){return Math.max(a,Math.min(b,v));}

function searchTip(prevFrame,currFrame,prevPoint,prevPrevPoint,template,t,seedBatLength){
  const vx=prevPrevPoint?prevPoint.x-prevPrevPoint.x:0;
  const vy=prevPrevPoint?prevPoint.y-prevPrevPoint.y:0;
  const speed=Math.hypot(vx,vy);
  let pred={x:prevPoint.x+vx*.88,y:prevPoint.y+vy*.88};
  const handN=handAt(t);
  let hand=null;
  if(handN) hand=normToTrack(handN,currFrame);
  const radius=clamp(30+speed*1.5,32,92);
  const stride=radius>70?3:2;
  let best=null;
  for(let y=Math.max(8,Math.round(pred.y-radius));y<=Math.min(currFrame.h-9,Math.round(pred.y+radius));y+=stride){
    for(let x=Math.max(8,Math.round(pred.x-radius));x<=Math.min(currFrame.w-9,Math.round(pred.x+radius));x+=stride){
      const dp=Math.hypot(x-pred.x,y-pred.y);
      if(dp>radius) continue;
      let lenPenalty=0;
      if(hand && seedBatLength){
        const L=Math.hypot(x-hand.x,y-hand.y);
        const ratio=L/seedBatLength;
        if(ratio<.58||ratio>1.48) continue;
        lenPenalty=Math.abs(ratio-1)*.72;
      }
      const corr=patchCorr(template,currFrame,x,y);
      const motion=localMotion(prevFrame,currFrame,x,y);
      const edge=localEdge(currFrame,x,y);
      const score=.72*corr+.18*motion+.10*edge-lenPenalty-dp/(radius*9);
      if(!best||score>best.score) best={x,y,score,corr,motion,edge};
    }
  }
  return best;
}

async function trackDirection(seedTime,endTime,dir,seedNorm,frameStep,progressCb){
  await seekTo(seedTime);
  let prevFrame=captureTrackFrame();
  let prevPoint=normToTrack(seedNorm,prevFrame);
  let prevPrevPoint=null;
  let template=makePatch(prevFrame,prevPoint);
  const seedHandN=handAt(seedTime);
  const seedBatLength=seedHandN?Math.hypot((seedNorm.x-seedHandN.x)*prevFrame.w,(seedNorm.y-seedHandN.y)*prevFrame.h):null;
  const out=[];
  const total=Math.max(1,Math.ceil(Math.abs(endTime-seedTime)/frameStep));
  let weak=0;
  for(let i=1;i<=total;i++){
    if(cancelled) break;
    let t=seedTime+dir*i*frameStep;
    if((dir>0&&t>endTime+.0001)||(dir<0&&t<endTime-.0001)) break;
    t=clamp(t,0,media.duration);
    const manual=nearestManualTip(t,frameStep*.55);
    await seekTo(t);
    const currFrame=captureTrackFrame();
    let pNorm,quality=1;
    if(manual){
      pNorm=manual.p;
      const mp=normToTrack(pNorm,currFrame);
      prevPrevPoint=prevPoint; prevPoint=mp; template=makePatch(currFrame,mp); weak=0;
    }else{
      const best=searchTip(prevFrame,currFrame,prevPoint,prevPrevPoint,template,t,seedBatLength);
      if(!best) break;
      quality=best.score;
      pNorm=trackToNorm(best,currFrame);
      if(best.score<.06) weak++; else weak=Math.max(0,weak-1);
      if(weak>=5) break;
      prevPrevPoint=prevPoint; prevPoint={x:best.x,y:best.y};
      // Update from the immediately previous frame so rotation / blur can change gradually.
      template=makePatch(currFrame,prevPoint);
      out.push({t,p:pNorm,source:'auto',q:quality});
    }
    prevFrame=currFrame;
    progressCb(i/total);
    if(i%4===0) await new Promise(r=>setTimeout(r,0));
  }
  return out;
}

$('track-tip').onclick=async()=>{
  if(!media||media.kind==='image'||busy) return;
  const original=now();
  try{
    const [a,b]=interval();
    const manualSeeds=marks.tip.filter(x=>x.p&&x.source!=='auto'&&x.t>=a-.05&&x.t<=b+.05);
    if(!manualSeeds.length) throw new Error('開始～終了の範囲内でバット先端を1回タップしてください。');
    const seed=manualSeeds.reduce((best,x)=>Math.abs(x.t-a)<Math.abs(best.t-a)?x:best,manualSeeds[0]);
    remember();
    busy=true; cancelled=false; video.pause(); editing=picking=false; setEditUI(); buttons();
    $('tip-progress').hidden=false; $('tip-progress').value=0;
    status('バット先端をフレーム単位で自動追跡しています…');
    // Keep manual correction points and rebuild only automatic points inside the selected interval.
    marks.tip=marks.tip.filter(x=>x.source!=='auto'||x.t<a||x.t>b);
    const fpsGuess=30;
    const frameStep=1/fpsGuess;
    const forwardSpan=Math.max(0,b-seed.t), backwardSpan=Math.max(0,seed.t-a), allSpan=Math.max(.001,forwardSpan+backwardSpan);
    const forward=await trackDirection(seed.t,b,1,seed.p,frameStep,p=>{$('tip-progress').value=(p*forwardSpan)/allSpan;});
    let backward=[];
    if(!cancelled&&backwardSpan>.02){
      backward=await trackDirection(seed.t,a,-1,seed.p,frameStep,p=>{$('tip-progress').value=(forwardSpan+p*backwardSpan)/allSpan;});
    }
    marks.tip.push(...forward,...backward);
    marks.tip.sort((x,y)=>x.t-y.t);
    counts();
    const weak=[...forward,...backward].filter(x=>(x.q??1)<.12).length;
    status(`先端追跡が完了しました。自動 ${forward.length+backward.length}点。${weak?`低信頼 ${weak}点があります。外れた場所だけタップ補正してください。`:'軌跡を再生して確認してください。'}`);
  }catch(e){
    console.error(e); status('先端追跡できませんでした。'+e.message);
  }finally{
    busy=false; $('tip-progress').hidden=true;
    await seekTo(original).catch(()=>{}); buttons(); draw();
  }
};

function download(blob,name){
  const u=URL.createObjectURL(blob), a=document.createElement('a');
  a.href=u; a.download=name; a.click();
  setTimeout(()=>URL.revokeObjectURL(u),1500);
}

$('snapshot').onclick=()=>{ draw(); canvas.toBlob(b=>{if(b)download(b,'swing-'+now().toFixed(2)+'.png');},'image/png'); };
$('save').onclick=()=>download(new Blob([JSON.stringify(state(),null,2)],{type:'application/json'}),'swing-analysis.json');

$('load').onchange=async e=>{
  try{
    if(!media) throw new Error('先に元の動画・写真を開いてください。');
    const file=e.target.files[0]; if(!file) return;
    if(file.size>20*1024*1024) throw new Error('データが大きすぎます。');
    const d=JSON.parse(await file.text());
    if(![1,2].includes(d.version)||d.media?.name!==media.name||d.media?.width!==media.width||d.media?.height!==media.height||Math.abs(d.media.duration-media.duration)>.15) throw new Error('この映像の解析データではありません。');
    const validP=p=>p===null||(p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&Math.abs(p.x)<=4&&Math.abs(p.y)<=4);
    const validT=t=>Number.isFinite(t)&&t>=0&&t<=media.duration+.1;
    if(!d.marks||!['tip','hand'].every(k=>Array.isArray(d.marks[k])&&d.marks[k].every(x=>validT(x.t)&&validP(x.p)))||!Array.isArray(d.pose)||!d.pose.every(x=>validT(x.t)&&x.points&&Object.entries(x.points).every(([k,p])=>joints.includes(+k)&&validP(p)))||!d.corrections||!Object.entries(d.corrections).every(([k,v])=>validT(+k/1000)&&v&&Object.entries(v).every(([id,p])=>joints.includes(+id)&&validP(p)))||!validP(d.target)) throw new Error('解析データの形式が正しくありません。');
    marks=d.marks; for(const list of Object.values(marks)) list.sort((a,b)=>a.t-b.t);
    pose=d.pose; corrections=d.corrections; target=d.target; history=[];
    counts(); buttons(); draw(); status('解析データを読み込みました。');
  }catch(e){ status(e.message); }
  e.target.value='';
};

$('record').onclick=async()=>{
  if(!media||busy||recording) return;
  let stream;
  const original=now(), oldSpeed=video.playbackRate;
  try{
    const [a,b]=interval();
    const candidates=['video/mp4;codecs=avc1.42E01E','video/mp4','video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm'];
    const mime=candidates.find(x=>MediaRecorder.isTypeSupported(x));
    if(!mime) throw new Error('このブラウザーでは動画保存形式が見つかりません。');
    video.pause(); recording=true; buttons(); await seekTo(a); draw();
    stream=canvas.captureStream(30);
    recorder=new MediaRecorder(stream,{mimeType:mime});
    const chunks=[];
    recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
    const done=new Promise((resolve,reject)=>{recorder.onstop=resolve;recorder.onerror=e=>reject(e.error||new Error('録画エラー'));});
    video.playbackRate=1; recorder.start(); await video.play();
    status('解析動画を保存中です。この画面を開いたままお待ちください。');
    await new Promise(resolve=>{const id=setInterval(()=>{if(video.currentTime>=b||video.ended){clearInterval(id);resolve();}},30);});
    video.pause(); recorder.stop(); await done;
    const ext=mime.startsWith('video/mp4')?'mp4':'webm';
    download(new Blob(chunks,{type:mime}),`swing-analysis.${ext}`);
    status(`選択区間を無音の${ext.toUpperCase()}動画で保存しました。`);
  }catch(e){ status(e.message); }
  finally{
    if(recorder?.state==='recording') recorder.stop();
    stream?.getTracks().forEach(t=>t.stop());
    video.pause(); video.playbackRate=oldSpeed; recording=false;
    await seekTo(original).catch(()=>{}); buttons(); draw();
  }
};

const modelContext=document.modelContext;
if(modelContext?.registerTool){
  try{
    Promise.resolve(modelContext.registerTool({
      name:'set_swing_display',description:'スイング解析の表示モードを切り替える',
      inputSchema:{type:'object',properties:{mode:{type:'string',enum:['overlay','original','markers']}},required:['mode'],additionalProperties:false},
      annotations:{readOnlyHint:false},
      execute(input){setView(input.mode);return{mode};}
    })).catch(console.warn);
  }catch(e){console.warn(e);}
}

grid();
