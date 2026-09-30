// www.freedom8964.com → freedom8964.com（保留路径和参数）
export default {
  fetch(request) {
    const u = new URL(request.url);
    u.hostname = "freedom8964.com";
    return Response.redirect(u.toString(), 301);
  },
};
