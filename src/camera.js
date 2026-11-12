/* =========================================================================
 * camera.js — P13 反抖动关键：**不对相机位置做追赶插值**
 * 只对 yaw/sf/pull/side/lift/blend 这些标量做帧率无关指数平滑
 * k(rate)=1-exp(-dt*rate)，再用「车当前位置 + 平滑偏移量」直接算 pos。
 * ========================================================================= */
(function () {
  'use strict';
  var CR = window.CR;
  var Cam = CR.Cam = {};
  var S = { yaw: 0, sf: 0, pull: 0, side: 0, lift: 0, blend: 0, boost: 0, mode: 0 };
  var _pos = new THREE.Vector3(), _look = new THREE.Vector3();

  function exp(a, b, rate, dt) { return a + (b - a) * (1 - Math.exp(-dt * rate)); }

  Cam.toggle = function () { Cam.setMode(S.mode ? 0 : 1); };
  Cam.setMode = function (m) { S.mode = m ? 1 : 0; };
  Cam.getMode = function () { return S.mode; };
  Cam.state = S;

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
    S.blend = exp(S.blend, S.mode, 3.2, dt);

    var dist = CR.lerp(12.2 + 2 * S.sf + 1.8 * S.pull, 48, S.blend);
    var height = CR.lerp(5.4 + 0.45 * S.sf, 30, S.blend);
    var ahead = CR.lerp(7.5, 38, S.blend);

    var fx = Math.sin(S.yaw), fz = Math.cos(S.yaw);
    var rx = Math.cos(S.yaw), rz = -Math.sin(S.yaw);
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
