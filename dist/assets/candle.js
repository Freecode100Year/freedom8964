// 首页蜡烛：单击蜡烛或按钮点燃。
// 点燃状态记在 sessionStorage（只在当前标签页、只在本站有效）：在本站内换页再回首页仍然亮着；
// 关闭标签页或离开本站（见 lang.js）后熄灭。不发送任何请求，不计数。
(function () {
  var KEY = "candle-lit";
  var c = document.getElementById("candle"), b = document.getElementById("light");
  if (!c) return;

  function light(animate) {
    if (!animate) c.classList.add("no-fade");
    c.classList.add("lit");
    c.setAttribute("aria-pressed", "true");
    if (b) { b.disabled = true; b.textContent = b.getAttribute("data-done") || b.textContent; }
  }
  function onLight() {
    if (c.classList.contains("lit")) return;
    try { sessionStorage.setItem(KEY, "1"); } catch (e) {}
    light(true);
  }

  var lit = false;
  try { lit = sessionStorage.getItem(KEY) === "1"; } catch (e) {}
  if (lit) light(false);

  c.addEventListener("click", onLight);
  c.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onLight(); }
  });
  if (b) b.addEventListener("click", onLight);
})();
