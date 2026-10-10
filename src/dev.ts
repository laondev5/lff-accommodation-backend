import app from "./app";
import { env } from "./config/env";

app.listen(env.PORT, () => console.log(`API listening on http://localhost:${env.PORT}`));
