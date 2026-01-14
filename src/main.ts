import { main } from './generate-images';

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
