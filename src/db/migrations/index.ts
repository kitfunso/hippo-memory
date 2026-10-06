import type { Migration } from './types.js';
import { v01 } from './v01.js';
import { v02 } from './v02.js';
import { v03 } from './v03.js';
import { v04 } from './v04.js';
import { v05 } from './v05.js';
import { v06 } from './v06.js';
import { v07 } from './v07.js';
import { v08 } from './v08.js';
import { v09 } from './v09.js';
import { v10 } from './v10.js';
import { v11 } from './v11.js';
import { v12 } from './v12.js';
import { v13 } from './v13.js';
import { v14 } from './v14.js';
import { v15 } from './v15.js';
import { v16 } from './v16.js';
import { v17 } from './v17.js';
import { v18 } from './v18.js';
import { v19 } from './v19.js';
import { v20 } from './v20.js';
import { v21 } from './v21.js';
import { v22 } from './v22.js';
import { v23 } from './v23.js';
import { v24 } from './v24.js';
import { v25 } from './v25.js';
import { v26 } from './v26.js';
import { v27 } from './v27.js';
import { v28 } from './v28.js';
import { v29 } from './v29.js';
import { v30 } from './v30.js';
import { v31 } from './v31.js';
import { v32 } from './v32.js';
import { v33 } from './v33.js';
import { v34 } from './v34.js';
import { v35 } from './v35.js';
import { v36 } from './v36.js';
import { v37 } from './v37.js';
import { v38 } from './v38.js';
import { v39 } from './v39.js';
import { v40 } from './v40.js';
import { v41 } from './v41.js';
import { v42 } from './v42.js';
import { v43 } from './v43.js';
import { v44 } from './v44.js';
import { v45 } from './v45.js';
import { v46 } from './v46.js';
import { v47 } from './v47.js';
import { v48 } from './v48.js';
import { v49 } from './v49.js';
import { v50 } from './v50.js';
import { v51 } from './v51.js';
import { v52 } from './v52.js';
import { v53 } from './v53.js';
import { v54 } from './v54.js';

export const CURRENT_SCHEMA_VERSION = 54;

/** Every schema migration in version order; runMigrations applies each one above the stored version. */
export const MIGRATIONS: Migration[] = [
  v01,
  v02,
  v03,
  v04,
  v05,
  v06,
  v07,
  v08,
  v09,
  v10,
  v11,
  v12,
  v13,
  v14,
  v15,
  v16,
  v17,
  v18,
  v19,
  v20,
  v21,
  v22,
  v23,
  v24,
  v25,
  v26,
  v27,
  v28,
  v29,
  v30,
  v31,
  v32,
  v33,
  v34,
  v35,
  v36,
  v37,
  v38,
  v39,
  v40,
  v41,
  v42,
  v43,
  v44,
  v45,
  v46,
  v47,
  v48,
  v49,
  v50,
  v51,
  v52,
  v53,
  v54,
];
