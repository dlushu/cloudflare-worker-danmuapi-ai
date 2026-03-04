// Cloudflare Worker 脚本 - 智能修正代理（使用环境变量）

// DeepSeek API 配置 - 从环境变量获取
const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';

// 目标API的基础URL - 也可以从环境变量获取
const TARGET_API_BASE = 'https://danmu.api.janelink.cn';

export default {
  async fetch(request, env, ctx) {
    // 处理CORS预检请求
    if (request.method === 'OPTIONS') {
      return handleCORS();
    }

    try {
      // 从环境变量获取DeepSeek API Key
      // 需要在Cloudflare Workers仪表板中设置环境变量 DEEPSEEK_API_KEY
      const DEEPSEEK_API_KEY = env.DEEPSEEK_API_KEY;
      
      if (!DEEPSEEK_API_KEY) {
        console.error('未设置DEEPSEEK_API_KEY环境变量');
        return new Response(JSON.stringify({
          errorCode: 500,
          success: false,
          errorMessage: '服务器配置错误：未设置DeepSeek API Key',
          isMatched: false,
          matches: []
        }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
          }
        });
      }

      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;
      
      // 检查是否启用调试模式（通过请求头或查询参数）
      const enableDebug = request.headers.get('X-Debug-Mode') === 'true' || 
                         url.searchParams.get('debug') === 'true' ||
                         env.ENABLE_DEBUG === 'true'; // 也可以从环境变量控制
      
      // 获取查询参数
      const queryParams = Object.fromEntries(url.searchParams);
      
      // 获取请求体
      let bodyParams = null;
      let contentType = request.headers.get('Content-Type') || '';

      if (method !== 'GET' && method !== 'HEAD') {
        try {
          if (contentType.includes('application/json')) {
            bodyParams = await request.json();
          } else if (contentType.includes('application/x-www-form-urlencoded')) {
            const formData = await request.formData();
            bodyParams = Object.fromEntries(formData);
          } else {
            bodyParams = await request.text();
          }
        } catch (e) {
          console.error('解析请求体失败:', e);
        }
      }

      // 保存原始参数
      const originalQuery = JSON.parse(JSON.stringify(queryParams));
      const originalBody = bodyParams ? JSON.parse(JSON.stringify(bodyParams)) : null;

      console.log('原始查询参数:', queryParams);
      console.log('原始请求体:', bodyParams);

      // 步骤1: 智能判断并修正参数值（只修正错误的）
      const correctedQuery = await intelligentCorrect(queryParams, DEEPSEEK_API_KEY);
      const correctedBody = bodyParams ? await intelligentCorrect(bodyParams, DEEPSEEK_API_KEY) : null;
      
      console.log('修正后查询参数:', correctedQuery);
      console.log('修正后请求体:', correctedBody);

      // 步骤2: 判断是否有修改
      const hasChanges = {
        query: JSON.stringify(originalQuery) !== JSON.stringify(correctedQuery),
        body: JSON.stringify(originalBody) !== JSON.stringify(correctedBody)
      };

      // 步骤3: 构建转发请求（使用修正后的参数）
      const targetResponse = await forwardRequest(
        method,
        path,
        correctedQuery,
        correctedBody,
        contentType,
        request.headers
      );
      
      // 步骤4: 获取目标API的响应
      const responseBuffer = await targetResponse.arrayBuffer();
      const responseHeaders = new Headers(targetResponse.headers);

      // 步骤5: 如果需要调试，在响应头中添加调试信息
      if (enableDebug) {
        const debugInfo = {
          timestamp: new Date().toISOString(),
          request: {
            method: method,
            path: path,
            contentType: contentType,
            url: request.url
          },
          originalParams: {
            query: originalQuery,
            body: originalBody
          },
          correctedParams: hasChanges.query || hasChanges.body ? {
            query: hasChanges.query ? correctedQuery : undefined,
            body: hasChanges.body ? correctedBody : undefined
          } : undefined,
          hasChanges: hasChanges,
          env: {
            // 只显示环境变量名称，不显示实际值（安全考虑）
            hasDeepSeekKey: !!DEEPSEEK_API_KEY,
            debugEnabled: enableDebug
          }
        };
        
        // 将调试信息编码为Base64添加到响应头
        const debugJson = JSON.stringify(debugInfo);
        const debugBase64 = btoa(debugJson);
        responseHeaders.set('X-Debug-Info', debugBase64);
      }

      // 步骤6: 返回原始API响应（完全不变）
      return new Response(responseBuffer, {
        status: targetResponse.status,
        statusText: targetResponse.statusText,
        headers: responseHeaders
      });

    } catch (error) {
      console.error('处理请求时发生错误:', error);
      
      return new Response(JSON.stringify({
        errorCode: 500,
        success: false,
        errorMessage: '代理服务器处理错误: ' + error.message,
        isMatched: false,
        matches: []
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': '*',
          'Access-Control-Allow-Headers': '*',
        }
      });
    }
  }
};

// 智能判断并修正参数值（只修正错误的）
async function intelligentCorrect(params, apiKey) {
  if (!params || typeof params !== 'object') {
    return params;
  }

  const prompt = `你是一个智能参数值修正助手。请分析以下参数，只修正明显错误或不规范的值，保持正确的值不变。

原始参数:
${JSON.stringify(params, null, 2)}

判断规则：
1. 首先判断当前值是否正确/规范
2. 只修正明显错误或不规范的值

正确格式标准：
- fileName参数：正确的格式应该是 "节目名称 S(季数)E(集数)"，如 "一人之下 S1E2"
  * S和E大写
  * 节目名称和S1E2之间有一个空格
  * 季数和集数都是阿拉伯数字

- episode参数：正确的格式应该是纯数字，如 2、188

- anime/title/name/keyword等参数：正确的格式应该是纯节目名称，不包含季数集数信息，如 "一人之下"

- 其他参数：保持原样，不做判断

需要修正的情况示例：
1. fileName = "一人之下第一季第2集" → 需要修正为 "一人之下 S1E2"
2. fileName = "一人之下S1E2" → 需要修正为 "一人之下 S1E2"（缺少空格）
3. fileName = "一人之下 S1e2" → 需要修正为 "一人之下 S1E2"（e小写）
4. episode = "第2集" → 需要修正为 2
5. episode = "EP2" → 需要修正为 2
6. anime = "一人之下第一季第2集" → 需要修正为 "一人之下"

不需要修正的情况示例：
1. fileName = "一人之下 S1E2" → 已经是正确格式，保持不变
2. fileName = "斗破苍穹 S3E10" → 正确，保持不变
3. episode = 2 → 正确，保持不变
4. episode = 188 → 正确，保持不变
5. anime = "一人之下" → 正确，保持不变
6. 其他不相关的参数（如fileSize、videoDuration等）→ 保持不变

重要原则：
- 如果值已经是正确的，千万不要修改！
- 只修改明显错误的
- 不确定是否错误时，保持原样

返回格式：只返回修正后的参数对象JSON，不要任何解释文字

开始分析并修正：`;

  try {
    const response = await fetch(DEEPSEEK_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          {
            role: 'system',
            content: '你是一个智能参数值修正助手。只修正明显错误的值，正确的值千万不要修改！只返回JSON，不要任何解释。'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.1,
        max_tokens: 500
      })
    });

    if (!response.ok) {
      console.error(`DeepSeek API调用失败: ${response.status}`);
      return params;
    }

    const data = await response.json();
    const content = data.choices[0].message.content;
    
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return JSON.parse(content);
  } catch (e) {
    console.error('修正参数值失败:', e);
    return params;
  }
}

// 转发请求
async function forwardRequest(method, path, queryParams, bodyParams, contentType, originalHeaders) {
  const targetUrl = `${TARGET_API_BASE}${path}`;
  
  const queryString = new URLSearchParams();
  if (queryParams) {
    for (const [key, value] of Object.entries(queryParams)) {
      if (value !== null && value !== undefined) {
        queryString.append(key, String(value));
      }
    }
  }
  
  const fullUrl = queryString.toString() 
    ? `${targetUrl}?${queryString.toString()}`
    : targetUrl;
  
  console.log(`转发到: ${fullUrl}`);

  const headers = new Headers();
  const excludeHeaders = ['host', 'connection', 'content-length', 'cf-connecting-ip', 'cf-ray'];
  
  for (const [key, value] of originalHeaders.entries()) {
    if (!excludeHeaders.includes(key.toLowerCase())) {
      headers.set(key, value);
    }
  }
  
  headers.set('User-Agent', 'Cloudflare-Worker-Proxy');

  const requestOptions = {
    method: method,
    headers: headers,
    redirect: 'follow'
  };
  
  if (method !== 'GET' && method !== 'HEAD' && bodyParams) {
    if (typeof bodyParams === 'object') {
      if (contentType.includes('application/json')) {
        requestOptions.body = JSON.stringify(bodyParams);
      } else if (contentType.includes('application/x-www-form-urlencoded')) {
        const formBody = new URLSearchParams();
        for (const [key, value] of Object.entries(bodyParams)) {
          formBody.append(key, String(value));
        }
        requestOptions.body = formBody.toString();
      } else {
        requestOptions.body = JSON.stringify(bodyParams);
        headers.set('Content-Type', 'application/json');
      }
    } else {
      requestOptions.body = bodyParams;
    }
  }

  return await fetch(fullUrl, requestOptions);
}

// 辅助函数
function handleCORS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': '*',
      'Access-Control-Allow-Headers': '*',
    }
  });
}
