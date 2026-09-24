// 点蜡烛：只改变页面样式，不发送任何请求、不存储任何数据。
(function () {
  var c = document.getElementById("candle"), b = document.getElementById("light"), m = document.getElementById("msg");
  if (!c || !b) return;
  b.addEventListener("click", function () {
    c.classList.add("lit");
    b.disabled = true;
    b.textContent = "已点亮";
    m.textContent = "烛光已为他们点亮。谢谢你记得。";
  });
})();
