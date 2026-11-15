// 音效音量回归自检（lib/sound.ts），重点覆盖三处：
//   ① 旧版三档 level → 新倍率的读档迁移（用户升级后不该突然静音或炸响）
//   ② uisfx 的 setVolume 在库内被钳到 0..1 —— 本项目的放大级必须绕开它，
//      所以用假 AudioContext 跑真 uisfx，断言实际增益 = 倍率 × 可见性系数，且库内主音量恒为 1
//   ③ 拉大音量应自动解开总开关；倍率为 0 时不播放
// 运行：node tools/sound-volume-selftest.mjs
//
// 隔离：无真实 IO 与音频设备，全部虚构数据；不写 localStorage（内存 Map 顶替）。

import { createJiti } from "jiti";

const noop = () => {};

// ---------------- 假 Web Audio（只实现 uisfx 用到的子集） ----------------
function createFakeWebAudio() {
  const state = { gains: [], limiters: [], connections: [], destination: { kind: "destination" } };
  class FakeParam {
    constructor(value) {
      this.value = value;
      this.lastTarget = null;
      this.ramps = [];
    }
    setValueAtTime(v) {
      this.value = v;
    }
    linearRampToValueAtTime(v) {
      this.value = v;
      this.ramps.push(v);
    }
    cancelScheduledValues() {}
    cancelAndHoldAtTime() {}
    setTargetAtTime(v) {
      this.value = v;
      this.lastTarget = v;
    }
  }
  class FakeNode {
    constructor(kind, context) {
      this.kind = kind;
      this.context = context;
      this.gain = new FakeParam(kind === "gain" ? 1 : 0);
      this.playbackRate = new FakeParam(1);
      this.connected = [];
    }
    connect(target) {
      this.connected.push(target);
      state.connections.push([this, target]);
      return target;
    }
    disconnect() {}
  }
  class FakeAudioContext {
    constructor() {
      this.sampleRate = 44100;
      this.currentTime = 0;
      this.state = "running";
      this.destination = state.destination;
    }
    createGain() {
      const node = new FakeNode("gain", this);
      state.gains.push(node);
      return node;
    }
    createDynamicsCompressor() {
      const node = new FakeNode("compressor", this);
      for (const name of ["threshold", "knee", "ratio", "attack", "release"]) {
        node[name] = new FakeParam(0);
      }
      state.limiters.push(node);
      return node;
    }
    createBuffer(channels, length, sampleRate) {
      return {
        length,
        sampleRate,
        numberOfChannels: channels,
        getChannelData: () => new Float32Array(length),
      };
    }
    createBufferSource() {
      const node = new FakeNode("source", this);
      node.buffer = null;
      node.loop = false;
      node.start = () => {};
      node.stop = () => {};
      node.addEventListener = noop;
      return node;
    }
    resume() {
      this.state = "running";
      return Promise.resolve();
    }
    close() {
      return Promise.resolve();
    }
  }
  return { FakeAudioContext, state };
}

// ---------------- 模块级单例每次都要新开一份，才能测多次读档 ----------------
async function loadSoundModule(tag, storage, audio) {
  const listeners = { window: new Map(), document: new Map() };
  const map = new Map(Object.entries(storage));
  globalThis.window = {
    AudioContext: audio.FakeAudioContext,
    localStorage: {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, v),
    },
    addEventListener: (type, fn) => listeners.window.set(type, fn),
    removeEventListener: noop,
  };
  globalThis.document = {
    visibilityState: "visible",
    addEventListener: (type, fn) => listeners.document.set(type, fn),
    removeEventListener: noop,
  };
  const jiti = createJiti(import.meta.url, {
    alias: { "@": new URL("../", import.meta.url).pathname },
    cache: false,
    moduleCache: false,
  });
  const mod = await jiti.import(`../lib/sound.ts?case=${encodeURIComponent(tag)}`);
  return { mod, listeners, map };
}

let failed = 0;
function check(name, ok, detail = "") {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}
const near = (a, b) => Math.abs(a - b) < 1e-6;

// ---------------- ① 读档迁移 ----------------
{
  const audio = createFakeWebAudio();
  const cases = [
    ["legacy light", { level: "light" }, 0.8],
    ["legacy standard", { level: "standard", enabled: true }, 1.5],
    ["legacy muted", { level: "muted", enabled: false }, 0],
    ["new volume", { volume: 1.5, enabled: true }, 1.5],
    ["clamp high", { volume: 5, enabled: true }, 3],
    ["clamp low", { volume: -3, enabled: true }, 0],
    ["garbage", { volume: "loud", level: "standard" }, 1.5],
    ["default", {}, 1.5],
  ];
  for (const [name, raw, want] of cases) {
    const { mod } = await loadSoundModule(name, { "elenva:sound": JSON.stringify(raw) }, audio);
    const got = mod.getSoundPreferences().volume;
    check(`读档 ${name}`, near(got, want), `volume=${got} want=${want}`);
  }
}

// ---------------- ②③ 增益链路：放大级 / 主音量 / 自动解开总开关 ----------------
{
  const audio = createFakeWebAudio();
  const { mod, listeners, map } = await loadSoundModule(
    "gain",
    { "elenva:sound": JSON.stringify({ enabled: true, volume: 1.5, pack: "minimal", loop: false }) },
    audio,
  );

  // 模拟首次点击解锁（lib 在 pointerdown 上挂一次性监听）
  listeners.window.get("pointerdown")?.();
  await new Promise((r) => setTimeout(r, 50)); // 等动态 import("uisfx") 完成

  const played = mod.playCue("notification");
  check("解锁后可播放", played !== null);

  // uisfx 的创建顺序：voice gain（每条声的默认音量）→ master gain（主音量）→ 接到 destination。
  // 本项目自建的放大级是第一个 gain；链路应为 master → boost → limiter → 真实输出。
  const [boost] = audio.state.gains;
  const master = audio.state.gains.find((g) => g !== boost && g.connected.includes(boost));
  const voice = audio.state.gains.find((g) => g !== boost && g !== master);
  const [limiter] = audio.state.limiters;
  check("boost 接到限幅器而非直接出声", boost?.connected.includes(limiter) === true);
  check("限幅器接到真实输出", limiter?.connected.includes(audio.state.destination) === true);
  check("放大级增益 = 1.5 × 0.55（可见）", near(boost?.gain.value ?? -1, 0.825), `got=${boost?.gain.value}`);
  check("uisfx 主音量恒为 1（缩放不在库里做）", near(master?.gain.value ?? -1, 1), `got=${master?.gain.value}`);
  check("一次性 cue 的 per-voice 增益顶到 1", near(voice?.gain.value ?? -1, 1), `got=${voice?.gain.value}`);

  // 切到别的标签页 → 增益 ×1.0
  globalThis.document.visibilityState = "hidden";
  listeners.document.get("visibilitychange")?.();
  check("隐藏标签页增益 = 1.5", near(boost.gain.value, 1.5), `got=${boost.gain.value}`);

  // 显式传的 volume 不能被顶满（长任务 loop 用它保持安静）
  mod.playCue("processing", { volume: 0.8, loop: true, retrigger: "ignore" });
  const loopVoice = audio.state.gains.filter((g) => g !== boost && g !== master).at(-1);
  check("显式 volume 0.8 被保留（loop）", near(loopVoice?.gain.value ?? -1, 0.8), `got=${loopVoice?.gain.value}`);

  // 滑杆调整
  mod.updateSoundPreferences({ volume: 0.5 });
  check("滑杆调低后增益 = 0.5", near(boost.gain.value, 0.5), `got=${boost.gain.value}`);
  check("滑杆值已落盘", JSON.parse(map.get("elenva:sound")).volume === 0.5);

  // 总开关关着时调大音量 → 自动解开（用户意图就是「我要听到」）
  mod.updateSoundPreferences({ enabled: false });
  const after = mod.updateSoundPreferences({ volume: 0.9 });
  check("调大音量自动解开总开关", after.enabled === true && near(after.volume, 0.9), JSON.stringify(after));

  // 倍率 0 = 不出声
  mod.updateSoundPreferences({ volume: 0 });
  check("倍率 0 时不播放", mod.playCue("notification") === null);
}

console.log(failed ? `\nFAILED ${failed}` : "\nALL PASS");
process.exit(failed ? 1 : 0);
