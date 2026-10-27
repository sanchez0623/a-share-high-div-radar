import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';
import { createFileAssumptionStore } from './assumption-store.ts';
import { AS_OF, createDemoState } from './engine.ts';

const assumptionFile = fileURLToPath(new URL('./.data/assumptions.json', import.meta.url));
const app = createApp(createDemoState(), createFileAssumptionStore(assumptionFile));

app.listen(4174, () => {
  console.log(`演示后端已启动：http://localhost:4174（数据截至${AS_OF}）`);
});
