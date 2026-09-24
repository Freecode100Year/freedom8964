// 点蜡烛：只改变页面样式，不发送任何请求、不存储任何数据。
(function () {
  var c = document.getElementById("candle"), b = document.getElementById("light");
  if (!c || !b) return;
  b.addEventListener("click", function () {
    c.classList.add("lit");
    b.disabled = true;
    b.textContent = b.getAttribute("data-done") || b.textContent;
  });
})();
