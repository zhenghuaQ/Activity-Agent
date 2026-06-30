// ============================================================
// src/server/swagger-html.ts — Swagger UI 页面模板
// ============================================================

export const SWAGGER_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>AI出行决策 API 文档</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
</head>
<body>
  <div id="swagger"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    window.onload = () => {
      window.ui = SwaggerUIBundle({ url: "/openapi.json", dom_id: "#swagger" });
    };
  </script>
</body>
</html>`;
