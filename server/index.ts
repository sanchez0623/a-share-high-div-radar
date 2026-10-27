import { createApp } from './app.ts';
import { AS_OF, createDemoState } from './engine.ts';

const app = createApp(createDemoState());

app.listen(4174, () => {
  console.log(`演示后端已启动：http://localhost:4174（数据截至${AS_OF}）`);
});
