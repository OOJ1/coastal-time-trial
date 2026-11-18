/* =========================================================================
 * camera.js — P13 反抖动关键：**不对相机位置做追赶插值**
 * 只对 yaw/sf/pull/side/lift/blend 这些标量做帧率无关指数平滑
 * k(rate)=1-exp(-dt*rate)，再用「车当前位置 + 平滑偏移量」直接算 pos。
 *
 * 三个视角（C / Y 键循环）：0 追车 → 1 远景 → 2 第一人称（驾驶位）。
 * 第一人称不参与 blend 插值，硬切；眼点用与追车档同一份平滑 yaw，
 * 漂移时视角同样甩向速度方向；过弯按 yawRate 轻微滚转。
 * ========================================================================= */
(function () {
  'use strict';
  var CR = window.CR;
  var Cam = CR.Cam = {};
  var S = { yaw: 0, sf: 0, pull: 0, side: 0, lift: 0, blend: 0, boost: 0, mode: 0 };
  var _pos = new THREE.Vector3(), _look = new THREE.Vector3();

  function exp(a, b, rate, dt) { return a + (b - a) * (1 - Math.exp(-dt * rate)); }

  Cam.toggle = function () { Cam.setMode((S.mode + 1) % 3); };
  Cam.setMode = function (m) { S.mode = ((m % 3) + 3) % 3; };
  /* 模式名：0 追车 / 1 远景 / 2 第一人称（驾驶位） */
  Cam.MODES = ['追车', '远景', '第一人称'];
  Cam.getMode = function () { return S.mode; };
  Cam.state = S;

  /* 第一人称可调参数（fpview.js 的面板写这里；默认值 = 改动前的写死值）。
     pitch 单位度：负=低头。lookAhead 为看向车头前方的距离。 */
  Cam.fp = {
    eyeHeight: 1.18, side: 0.33, forward: 0.35,
    pitch: -0.5, fov: 68, fovSpeed: 10, fovBoost: 7,
    roll: 0.08, lookAhead: 30,
    /* 第一人称专用近平面：默认 0.25（原 1.0 会把 1m 内的车身整片裁掉，
       只剩一个被切开的白色截面）。追车/远景仍用 1，不影响后处理 AO 深度。 */
    near: 0.25
  };
  Cam.DEFAULT_NEAR = 1;

  Cam.update = function (camera, dt) {
    var st = CR.Car.state;
    var input = CR.autoInput || CR.Input.state;

    /* 朝向：车头 psi 与实际速度方向之间插值，权重随速度 smoothstep 渐入。
       漂移时能看到车横过来。 */
    var velYaw = Math.atan2(st.vx, st.vz);
    var w = CR.smoothstep(2, 24, st.speed);
    var targetYaw = st.psi + CR.angDiff(st.psi, velYaw) * 0.55 * w;
    S.yaw += CR.angDiff(S.yaw, targetYaw) * (1 - Math.exp(-dt * 4.2));

    S.sf = exp(S.sf, Math.min(1, st.speed / 62), 3, dt);
    /* 氮气：拉距 +0.5、FOV +6（都用 1-exp 平滑，禁止突变） */
    var boost = st.nitroActive ? 1 : 0;
    var pullT = (input.throttle ? 1 : (input.brake ? -0.5 : 0)) + 0.5 * boost;
    S.pull = exp(S.pull, pullT, 2.2, dt);
    S.boost = exp(S.boost, boost, 3.2, dt);
    S.side = exp(S.side, CR.clamp(-st.yawRate * 2.4, -2.6, 2.6), 2.5, dt);
    /* blend 只管 0↔1 两档远景过渡；切第一人称（mode 2）时按 0 处理，
       回到追车档不会从远景硬拽回来 */
    S.blend = exp(S.blend, S.mode === 1 ? 1 : 0, 3.2, dt);

    /* 朝向向量共用：f = 车头，r = 左向（与 car.js 的 l=(cosψ,-sinψ) 一致） */
    var fx = Math.sin(S.yaw), fz = Math.cos(S.yaw);
    var rx = Math.cos(S.yaw), rz = -Math.sin(S.yaw);

    /* ---------- 第一人称（mode 2）：驾驶位眼点，硬切不插值 ----------
       所有位置 / 视线 / FOV / 侧倾参数都来自 Cam.fp，可在游戏内面板实时调整。 */
    if (S.mode === 2) {
      var F = Cam.fp, eyeY = st.y + F.eyeHeight;
      /* 近平面只在第一人称改小，且仅在数值变化时更新投影矩阵 */
      var fpNear = CR.clamp(F.near, 0.01, 1);
      if (Math.abs(camera.near - fpNear) > 1e-4) {
        camera.near = fpNear; camera.updateProjectionMatrix();
      }
      camera.position.set(
        st.x + rx * F.side + fx * F.forward,
        eyeY,
        st.z + rz * F.side + fz * F.forward
      );
      camera.up.set(0, 1, 0);
      /* 视线：车头前方 lookAhead 米处，按 pitch 角度抬/压；yaw 复用追车档平滑值，
         漂移时视角同样会甩向速度方向 */
      var la = F.lookAhead;
      _look.set(
        st.x + fx * la,
        eyeY + Math.tan(F.pitch * Math.PI / 180) * la,
        st.z + fz * la
      );
      camera.lookAt(_look);
      /* 过弯侧倾：随 yawRate 滚转，上限随系数等比放宽（默认仍是 ±0.06） */
      var rollMax = F.roll * 0.75;
      camera.rotateZ(CR.clamp(st.yawRate * F.roll, -rollMax, rollMax));
      var fpFov = F.fov + F.fovSpeed * S.sf + 3 * Math.max(0, S.pull) + F.fovBoost * S.boost;
      if (Math.abs(camera.fov - fpFov) > 0.01) { camera.fov = fpFov; camera.updateProjectionMatrix(); }
      return;
    }

    /* ---------- 追车 / 远景（原有逻辑） ---------- */
    if (camera.near !== Cam.DEFAULT_NEAR) {
      camera.near = Cam.DEFAULT_NEAR; camera.updateProjectionMatrix();
    }
    var dist = CR.lerp(12.2 + 2 * S.sf + 1.8 * S.pull, 48, S.blend);
    var height = CR.lerp(5.4 + 0.45 * S.sf, 30, S.blend);
    var ahead = CR.lerp(7.5, 38, S.blend);

    _pos.set(st.x - fx * dist + rx * S.side, st.y + height, st.z - fz * dist + rz * S.side);

    /* 防穿山：need 平滑成 lift（升 12 / 降 3），不做硬夹 */
    var need = Math.max(0, CR.Terrain.heightAt(_pos.x, _pos.z) + 1.6 - _pos.y);
    S.lift = exp(S.lift, need, need > S.lift ? 12 : 3, dt);
    _pos.y += S.lift;

    camera.position.copy(_pos);
    _look.set(st.x + fx * ahead, st.y + 1.0 + S.blend * 2, st.z + fz * ahead);
    camera.up.set(0, 1, 0);
    camera.lookAt(_look);

    var fov = CR.lerp(53 + 12 * S.sf + 3 * Math.max(0, S.pull) + 6 * S.boost, 50, S.blend);
    if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }
  };

  /* 复位到当前车头朝向，避免切视角/重置时镜头突变 */
  Cam.snap = function () {
    S.yaw = CR.Car.state.psi;
    S.sf = 0; S.pull = 0; S.side = 0; S.lift = 0; S.boost = 0;
  };
})();
