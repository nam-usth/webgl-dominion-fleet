"use strict";

function parseOBJ(text) {
  // because indices are base 1 let's just fill in the 0th data
  const objPositions = [[0, 0, 0]];
  const objTexcoords = [[0, 0]];
  const objNormals = [[0, 0, 0]];

  // same order as `f` indices
  const objVertexData = [
    objPositions,
    objTexcoords,
    objNormals,
  ];

  // same order as `f` indices
  let webglVertexData = [
    [],   // positions
    [],   // texcoords
    [],   // normals
  ];

  const materialLibs = [];
  const geometries = [];
  let geometry;
  let groups = ['default'];
  let material = 'default';
  let object = 'default';

  const noop = () => {};

  function newGeometry() {
    // If there is an existing geometry and it's
    // not empty then start a new one.
    if (geometry && geometry.data.position.length) {
      geometry = undefined;
    }
  }

  function setGeometry() {
    if (!geometry) {
      const position = [];
      const texcoord = [];
      const normal = [];
      webglVertexData = [
        position,
        texcoord,
        normal,
      ];
      geometry = {
        object,
        groups,
        material,
        data: {
          position,
          texcoord,
          normal,
        },
      };
      geometries.push(geometry);
    }
  }

  function addVertex(vert) {
    const ptn = vert.split('/');
    ptn.forEach((objIndexStr, i) => {
      if (!objIndexStr) {
        return;
      }
      const objIndex = parseInt(objIndexStr);
      const index = objIndex + (objIndex >= 0 ? 0 : objVertexData[i].length);
      webglVertexData[i].push(...objVertexData[i][index]);
    });
  }

  const keywords = {
    v(parts) {
      objPositions.push(parts.map(parseFloat));
    },
    vn(parts) {
      objNormals.push(parts.map(parseFloat));
    },
    vt(parts) {
      // should check for missing v and extra w?
      objTexcoords.push(parts.map(parseFloat));
    },
    f(parts) {
      setGeometry();
      const numTriangles = parts.length - 2;
      for (let tri = 0; tri < numTriangles; ++tri) {
        addVertex(parts[0]);
        addVertex(parts[tri + 1]);
        addVertex(parts[tri + 2]);
      }
    },
    s: noop,    // smoothing group
    mtllib(parts, unparsedArgs) {
      // the spec says there can be multiple filenames here
      // but many exist with spaces in a single filename
      materialLibs.push(unparsedArgs);
    },
    usemtl(parts, unparsedArgs) {
      material = unparsedArgs;
      newGeometry();
    },
    g(parts) {
      groups = parts;
      newGeometry();
    },
    o(parts, unparsedArgs) {
      object = unparsedArgs;
      newGeometry();
    },
  };

  const keywordRE = /(\w*)(?: )*(.*)/;
  const lines = text.split('\n');
  for (let lineNo = 0; lineNo < lines.length; ++lineNo) {
    const line = lines[lineNo].trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const m = keywordRE.exec(line);
    if (!m) {
      continue;
    }
    const [, keyword, unparsedArgs] = m;
    const parts = line.split(/\s+/).slice(1);
    const handler = keywords[keyword];
    if (!handler) {
      console.warn('unhandled keyword:', keyword);  // eslint-disable-line no-console
      continue;
    }
    handler(parts, unparsedArgs);
  }

  // remove any arrays that have no entries.
  for (const geometry of geometries) {
    geometry.data = Object.fromEntries(
        Object.entries(geometry.data).filter(([, array]) => array.length > 0));
  }

  return {
    geometries,
    materialLibs,
  };
}

async function main() {
  // Get A WebGL context
  /** @type {HTMLCanvasElement} */
  const canvas = document.querySelector("#canvas");
  const gl = canvas.getContext("webgl");
  if (!gl) {
    return;
  }

  /* The shader programs for rendering the Fleet */
  const vs_world = `
  attribute vec4 a_position;
  attribute vec3 a_normal;
  attribute vec2 a_texcoord;

  uniform mat4 u_projection;
  uniform mat4 u_view;
  uniform mat4 u_world;

  varying vec4 v_position;
  varying vec3 v_normal;
  varying vec2 v_texcoord;

  void main() {
    gl_Position = u_projection * u_view * u_world * a_position;
    v_normal = mat3(u_world) * a_normal;
    v_texcoord = a_texcoord;
  }
  `;

  const fs_world = `
  precision mediump float;

  varying vec4 v_position;
  varying vec3 v_normal;
  varying vec2 v_texcoord;

  uniform vec4 u_diffuse;
  uniform vec3 u_lightDirection;
  uniform sampler2D u_texture0;
  uniform sampler2D u_texture1;
  uniform sampler2D u_texture2;
  
  uniform samplerCube u_skybox;

  uniform float u_time;

  void main () {
    vec3 u_cameraPosition;

    vec3 normal = normalize(v_normal);
    float fakeLight = dot(u_lightDirection, normal) * 1.5 + 1.0;

    vec4 color0 = texture2D(u_texture0, v_texcoord);
    vec4 color1 = texture2D(u_texture1, v_texcoord);
    vec4 color2 = texture2D(u_texture2, v_texcoord);

    float offSet = (sin(u_time * 5.0) + 1.0) * 0.5;

    gl_FragColor = (
      color0 
      + (color1 * vec4(offSet * 1.0, offSet * 1.0, offSet * 1.0, 1) * vec4(5.0, 5.0, 5.0, 1)) // enhance cyan-like color on this texture and make it brighter
      + color2 * vec4(0.25, 0.25, 0.25, 1)
      ) // make this texture darker
      * fakeLight;
  }
  `;

  /* The shader programs for rendering cloaking effect */
  const vs_world_cloak = `
  attribute vec4 a_position;
  attribute vec3 a_normal;
  attribute vec2 a_texcoord;

  uniform mat4 u_projection;
  uniform mat4 u_view;
  uniform mat4 u_world;

  varying vec4 v_position;
  varying vec3 v_normal;
  varying vec2 v_texcoord;

  void main() {
    gl_Position = u_projection * u_view * u_world * a_position;
    v_normal = mat3(u_world) * a_normal;
    v_texcoord = a_texcoord;
  }
  `;

  const fs_world_cloak = `
  precision mediump float;

  varying vec4 v_position;
  varying vec3 v_normal;
  varying vec2 v_texcoord;

  uniform vec4 u_diffuse;
  uniform vec3 u_lightDirection;
  uniform sampler2D u_texture0;
  uniform sampler2D u_texture1;
  uniform sampler2D u_texture2;

  uniform samplerCube u_skybox;
  
  uniform float u_time;

  void main () {
    vec3 u_cameraPosition = vec3(cos(u_time * .075), 0.0, sin(u_time * .075));

    float ratio = 1.00 / 1.52;

    vec3 normal = normalize(v_normal);

    vec3 I = normalize(v_position.xyz - u_cameraPosition);

    vec3 R1 = refract(I, normal, ratio);
    vec3 R2 = reflect(I, normal);

    vec3 R = R1 * R2;

    gl_FragColor = vec4(textureCube(u_skybox, R).rgb, 1.0);
  }
  `;

  /* The shader programs for rendering the skybox */
  const vs_skybox = `
  attribute vec4 a_position;
  varying vec4 v_position;
  void main() {
    v_position = a_position;
    gl_Position = a_position;
    gl_Position.z = 1.0;
  }
  `;

  const fs_skybox = `
  precision mediump float;

  uniform samplerCube u_skybox;
  uniform mat4 u_viewDirectionProjectionInverse;
  
  varying vec4 v_position;
  void main() {
    vec4 t = u_viewDirectionProjectionInverse * v_position;
    gl_FragColor = textureCube(u_skybox, normalize(t.xyz / t.w));
  }
  `;

  // compiles and links the shaders, looks up attribute and uniform locations
  const meshProgramInfo = webglUtils.createProgramInfo(gl, [vs_world, fs_world]);
  const meshCloakProgramInfo = webglUtils.createProgramInfo(gl, [vs_world_cloak, fs_world_cloak]);

  /* Read the first Battlecruiser .obj data */
  var response = await fetch('./static/models/battlecruiser_silver.obj', { mode: 'no-cors' });
  var text = await response.text();
  
  const obj_1 = parseOBJ(text);

  /* Read the second Battlecruiser .obj data */

  response = await fetch('./static/models/battlecruiser_umojan.obj', { mode: 'no-cors' });
  text = await response.text();
  
  const obj_2 = parseOBJ(text); 

  /* Read the Wraith .obj data */

  response = await fetch('./static/models/wraith.obj', { mode: 'no-cors' });
  text = await response.text();
  
  const obj_3 = parseOBJ(text); 

  /* Read the Viking .obj data */

  response = await fetch('./static/models/viking.obj', { mode: 'no-cors' });
  text = await response.text();
  
  const obj_4 = parseOBJ(text); 

  /* Read the Liberator .obj data */

  response = await fetch('./static/models/liberator.obj', { mode: 'no-cors' });
  text = await response.text();
  
  const obj_5 = parseOBJ(text); 

  /* Read the Raven .obj data */

  response = await fetch('./static/models/raven_BO.obj', { mode: 'no-cors' });
  text = await response.text();
  
  const obj_6 = parseOBJ(text); 

  const parts_1 = obj_1.geometries.map(({data}) => {
    // Because data is just named arrays like this
    //
    // {
    //   position: [...],
    //   texcoord: [...],
    //   normal: [...],
    // }
    //
    // and because those names match the attributes in our vertex
    // shader we can pass it directly into `createBufferInfoFromArrays`
    // from the article "less code more fun".

    // create a buffer for each array by calling
    // gl.createBuffer, gl.bindBuffer, gl.bufferData
    const bufferInfo = webglUtils.createBufferInfoFromArrays(gl, data);
    return {
      material: {
        u_diffuse: [Math.random(), Math.random(), Math.random(), 1],
      },
      bufferInfo,
    };
  });

  const parts_2 = obj_2.geometries.map(({data}) => {
    const bufferInfo = webglUtils.createBufferInfoFromArrays(gl, data);
    return {
      material: {
        u_diffuse: [Math.random(), Math.random(), Math.random(), 1],
      },
      bufferInfo,
    };
  });

  const parts_3 = obj_3.geometries.map(({data}) => {
    const bufferInfo = webglUtils.createBufferInfoFromArrays(gl, data);
    return {
      material: {
        u_diffuse: [Math.random(), Math.random(), Math.random(), 1],
      },
      bufferInfo,
    };
  });

  const parts_4 = obj_4.geometries.map(({data}) => {
    const bufferInfo = webglUtils.createBufferInfoFromArrays(gl, data);
    return {
      material: {
        u_diffuse: [Math.random(), Math.random(), Math.random(), 1],
      },
      bufferInfo,
    };
  });

  const parts_5 = obj_5.geometries.map(({data}) => {
    const bufferInfo = webglUtils.createBufferInfoFromArrays(gl, data);
    return {
      material: {
        u_diffuse: [Math.random(), Math.random(), Math.random(), 1],
      },
      bufferInfo,
    };
  });

  const parts_6 = obj_6.geometries.map(({data}) => {
    const bufferInfo = webglUtils.createBufferInfoFromArrays(gl, data);
    return {
      material: {
        u_diffuse: [Math.random(), Math.random(), Math.random(), 1],
      },
      bufferInfo,
    };
  });

  var object_1_parts = [];
  var object_2_parts = [];
  var object_3_parts = [];
  var object_4_parts = [];
  var object_5_parts = [];
  var object_6_parts = [];

  var object_1_coords = [];
  var object_2_coords = [];
  var object_3_coords = [];
  var object_4_coords = [];
  var object_5_coords = [];
  var object_6_coords = [];

  var num_object_1s = 5; // Battlecruiser Silver
  var num_object_2s = 1; // Battlecruiser Umojan  
  var num_object_3s = 3; // Wraith
  var num_object_4s = 4; // Viking
  var num_object_5s = 2; // Liberator
  var num_object_6s = 1; // Raven BO

  for (var ii = 0; ii < num_object_1s; ++ii) {
    object_1_parts.push(parts_1);
  }
  for (var ii = 0; ii < num_object_2s; ++ii) {
    object_2_parts.push(parts_2);
  }
  for (var ii = 0; ii < num_object_3s; ++ii) {
    object_3_parts.push(parts_3);
  }
  for (var ii = 0; ii < num_object_4s; ++ii) {
    object_4_parts.push(parts_4);
  }
  for (var ii = 0; ii < num_object_5s; ++ii) {
    object_5_parts.push(parts_5);
  }
  for (var ii = 0; ii < num_object_6s; ++ii) {
    object_6_parts.push(parts_6);
  }

  object_1_coords = [
    [-5, 1.5, -2],
    [5, 1.5, -2],
    [-10, 0, -6],
    [10, 0, -6],
    [0, 0.75, -8],
  ];
  object_2_coords = [
    [0, 0, 0],
  ];
  object_3_coords = [
    [-5, 0, 3],
    [0, 0, 5],
    [5, 0, 3],
  ];
  object_4_coords = [
    [-2.5, 0, 7.5],
    [2.5, 0, 7.5],
    [-4, -0.5, -6],
    [4, -0.5, -6],
  ];
  object_5_coords = [
    [-2.5, 1, 2.5],
    [2.5, 1, 2.5],
  ];
  object_6_coords = [
    [0, 3, -3],
  ];

  /* PREPARE THE TEXTURE FOR 3D MODELS */

  /* Texture of the first Battlecruiser */
  var texture_0 = gl.createTexture();
  var texture_1 = gl.createTexture();
  var texture_2 = gl.createTexture();

  gl.bindTexture(gl.TEXTURE_2D, texture_0);
  // Fill the texture with a 1x1 blue pixel.
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
                new Uint8Array([0, 0, 255, 255]));
  // Asynchronously load an image
  var image_0 = new Image(); // This has to be different from the second and third image - Otherwise, the last texture will overwrite the others
  image_0.src = './static/textures/battlecruiser_silver_diff.jpg';
  image_0.addEventListener('load', function() {
    // Flip the image Y coordinate
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    // Now that the image has loaded make copy it to the texture.
    gl.bindTexture(gl.TEXTURE_2D, texture_0);

    // Set the parameters so we can render any size image.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image_0);

    gl.bindTexture(gl.TEXTURE_2D, null);
  });

  gl.bindTexture(gl.TEXTURE_2D, texture_1);
  var image_1 = new Image(); 
  image_1.src = './static/textures/battlecruiser_silver_emis.jpg';
  image_1.addEventListener('load', function() {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.bindTexture(gl.TEXTURE_2D, texture_1);

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image_1);

    gl.bindTexture(gl.TEXTURE_2D, null);
  });

  gl.bindTexture(gl.TEXTURE_2D, texture_2);
  var image_2 = new Image(); 
  image_2.src = './static/textures/battlecruiser_silver_gloss.jpg';
  image_2.addEventListener('load', function() {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.bindTexture(gl.TEXTURE_2D, texture_2);

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image_2);

    gl.bindTexture(gl.TEXTURE_2D, null);
  });

  /* Texture of the second Battlecruiser */
  var texture_3 = gl.createTexture();
  var texture_4 = gl.createTexture();
  var texture_5 = gl.createTexture();

  gl.bindTexture(gl.TEXTURE_2D, texture_3);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
                new Uint8Array([0, 0, 255, 255]));
  var image_3 = new Image(); 
  image_3.src = './static/textures/battlecruiser_umojan_diffuse.jpg';
  image_3.addEventListener('load', function() {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.bindTexture(gl.TEXTURE_2D, texture_3);

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image_3);

    gl.bindTexture(gl.TEXTURE_2D, null);
  });

  var image_4 = new Image(); 
  image_4.src = './static/textures/battlecruiser_umojan_emissive.jpg';
  image_4.addEventListener('load', function() {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.bindTexture(gl.TEXTURE_2D, texture_4);

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image_4);

    gl.bindTexture(gl.TEXTURE_2D, null);
  });

  var image_5 = new Image(); 
  image_5.src = './static/textures/battlecruiser_umojan_emissive.jpg';
  image_5.addEventListener('load', function() {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.bindTexture(gl.TEXTURE_2D, texture_5);

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image_5);

    gl.bindTexture(gl.TEXTURE_2D, null);
  });

  /* Texture of the Wraith */
  var texture_6 = gl.createTexture();
  var texture_7 = gl.createTexture();
  var texture_8 = gl.createTexture();

  gl.bindTexture(gl.TEXTURE_2D, texture_6);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
                new Uint8Array([0, 0, 255, 255]));
  var image_6 = new Image(); 
  image_6.src = './static/textures/wraith_diffuse.jpg';
  image_6.addEventListener('load', function() {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.bindTexture(gl.TEXTURE_2D, texture_6);

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image_6);

    gl.bindTexture(gl.TEXTURE_2D, null);
  });

  var image_7 = new Image(); 
  image_7.src = './static/textures/wraith_emissive.jpg';
  image_7.addEventListener('load', function() {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.bindTexture(gl.TEXTURE_2D, texture_7);

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image_7);

    gl.bindTexture(gl.TEXTURE_2D, null);
  });

  var image_8 = new Image(); 
  image_8.src = './static/textures/wraith_emissive.jpg';
  image_8.addEventListener('load', function() {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.bindTexture(gl.TEXTURE_2D, texture_8);

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image_8);

    gl.bindTexture(gl.TEXTURE_2D, null);
  });

  /* Texture of the Viking */
  var texture_9 = gl.createTexture();
  var texture_10 = gl.createTexture();
  var texture_11 = gl.createTexture();

  gl.bindTexture(gl.TEXTURE_2D, texture_9);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
                new Uint8Array([0, 0, 255, 255]));
  var image_9 = new Image(); 
  image_9.src = './static/textures/viking_diffuse.jpg';
  image_9.addEventListener('load', function() {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.bindTexture(gl.TEXTURE_2D, texture_9);

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image_9);

    gl.bindTexture(gl.TEXTURE_2D, null);
  });

  var image_10 = new Image(); 
  image_10.src = './static/textures/viking_emissive.jpg';
  image_10.addEventListener('load', function() {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.bindTexture(gl.TEXTURE_2D, texture_10);

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image_10);

    gl.bindTexture(gl.TEXTURE_2D, null);
  });

  var image_11 = new Image(); 
  image_11.src = './static/textures/viking_emissive.jpg';
  image_11.addEventListener('load', function() {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.bindTexture(gl.TEXTURE_2D, texture_11);

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image_11);

    gl.bindTexture(gl.TEXTURE_2D, null);
  });

  /* Texture of the Viking */
  var texture_12 = gl.createTexture();
  var texture_13 = gl.createTexture();
  var texture_14 = gl.createTexture();

  gl.bindTexture(gl.TEXTURE_2D, texture_12);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
                new Uint8Array([0, 0, 255, 255]));
  var image_12 = new Image(); 
  image_12.src = './static/textures/liberator_diff.jpg';
  image_12.addEventListener('load', function() {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.bindTexture(gl.TEXTURE_2D, texture_12);

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image_12);

    gl.bindTexture(gl.TEXTURE_2D, null);
  });

  var image_13 = new Image(); 
  image_13.src = './static/textures/liberator_emiss.jpg';
  image_13.addEventListener('load', function() {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.bindTexture(gl.TEXTURE_2D, texture_13);

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image_13);

    gl.bindTexture(gl.TEXTURE_2D, null);
  });

  var image_14 = new Image(); 
  image_14.src = './static/textures/liberator_emiss.jpg';
  image_14.addEventListener('load', function() {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.bindTexture(gl.TEXTURE_2D, texture_14);

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image_14);

    gl.bindTexture(gl.TEXTURE_2D, null);
  });

  /* Texture of the Raven */
  var texture_15 = gl.createTexture();
  var texture_16 = gl.createTexture();
  var texture_17 = gl.createTexture();

  gl.bindTexture(gl.TEXTURE_2D, texture_15);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
                new Uint8Array([0, 0, 255, 255]));
  var image_15 = new Image(); 
  image_15.src = './static/textures/raven_diffuse.jpg';
  image_15.addEventListener('load', function() {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.bindTexture(gl.TEXTURE_2D, texture_15);

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image_15);

    gl.bindTexture(gl.TEXTURE_2D, null);
  });

  var image_16 = new Image(); 
  image_16.src = './static/textures/raven_blackops_emiss.jpg';
  image_16.addEventListener('load', function() {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.bindTexture(gl.TEXTURE_2D, texture_16);

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image_16);

    gl.bindTexture(gl.TEXTURE_2D, null);
  });

  var image_17 = new Image(); 
  image_17.src = './static/textures/raven_blackops_emiss.jpg';
  image_17.addEventListener('load', function() {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.bindTexture(gl.TEXTURE_2D, texture_17);

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image_17);

    gl.bindTexture(gl.TEXTURE_2D, null);
  });

  /* THE SKYBOX */
  const skyboxProgramInfo = webglUtils.createProgramInfo(gl, [vs_skybox, fs_skybox]);
  var positionLocation = gl.getAttribLocation(skyboxProgramInfo.program, "a_position");

  // lookup uniforms
  var skyboxLocation = gl.getUniformLocation(skyboxProgramInfo.program, "u_skybox");
  var skyboxViewDirectionProjectionInverseLocation =
      gl.getUniformLocation(skyboxProgramInfo.program, "u_viewDirectionProjectionInverse");

  // Create a buffer for positions
  var positionBuffer = gl.createBuffer();
  // Bind it to ARRAY_BUFFER (think of it as ARRAY_BUFFER = positionBuffer)
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  // Put the positions in the buffer
  setGeometry(gl);

  // Create a texture.
  var texture_skybox = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_CUBE_MAP, texture_skybox);

  const faceInfos = [
    {
      target: gl.TEXTURE_CUBE_MAP_POSITIVE_X,
      url: './static/textures/skybox_example_right.jpg', 
    },
    {
      target: gl.TEXTURE_CUBE_MAP_NEGATIVE_X,
      url: './static/textures/skybox_example_left.jpg', 
    },
    {
      target: gl.TEXTURE_CUBE_MAP_POSITIVE_Y,
      url: './static/textures/skybox_example_top.jpg', 
    },
    {
      target: gl.TEXTURE_CUBE_MAP_NEGATIVE_Y,
      url: './static/textures/skybox_example_bottom.jpg', 
    },
    {
      target: gl.TEXTURE_CUBE_MAP_POSITIVE_Z,
      url: './static/textures/skybox_example_back.jpg',
    },
    {
      target: gl.TEXTURE_CUBE_MAP_NEGATIVE_Z,
      url: './static/textures/skybox_example_front.jpg', 
    },
  ];
  faceInfos.forEach((faceInfo) => {
    const {target, url} = faceInfo;

    // Upload the canvas to the cubemap face.
    const level = 0;
    const internalFormat = gl.RGBA;
    const width = 1024;
    const height = 1024;
    const format = gl.RGBA;
    const type = gl.UNSIGNED_BYTE;

    // setup each face so it's immediately renderable
    gl.texImage2D(target, level, internalFormat, width, height, 0, format, type, null);

    // Asynchronously load an image
    const image_skybox = new Image();
    image_skybox.src = url;
    image_skybox.addEventListener('load', function() {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);

      // Now that the image has loaded make copy it to the texture.
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, texture_skybox);
      gl.texImage2D(target, level, internalFormat, format, type, image_skybox);
      gl.generateMipmap(gl.TEXTURE_CUBE_MAP);
    });
  });
  gl.generateMipmap(gl.TEXTURE_CUBE_MAP);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);

  // Fill the buffer with the values that define a quad.
  function setGeometry(gl) {
    var positions = new Float32Array(
      [
        -1, -1,
         1, -1,
        -1,  1,
        -1,  1,
         1, -1,
         1,  1,
      ]);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
  }

  /* MOUSE EVENTS */
  var AMORTIZATION = 0.95;
  var drag = false;
  var old_x, old_y;
  var dX = 0, dY = 0;

  var THETA = 0, PHI = 0;

  var cloakMode = false;  

  var mouseDown = function(e) {
    drag = true;
    old_x = e.pageX, old_y = e.pageY;
    e.preventDefault();
    return false;
  };

  var mouseUp = function(e){
    drag = false;
  };

  var mouseMove = function(e) {
    if (!drag) return false;
    dX = (e.pageX-old_x)*2*Math.PI/canvas.width,
    dY = (e.pageY-old_y)*2*Math.PI/canvas.height;
    THETA += dX;
    PHI += dY;
    old_x = e.pageX, old_y = e.pageY;
    e.preventDefault();
  };

  var mouseWheel = function(e) {
    if (e.deltaY < 0) {
      cloakMode = false;
    } 
    else if (e.deltaY > 0)
    {
      cloakMode = true;
    }
    e.preventDefault();
    return false;
  };

  canvas.addEventListener("mousedown", mouseDown, false);
  canvas.addEventListener("mouseup", mouseUp, false);
  canvas.addEventListener("mouseout", mouseUp, false);
  canvas.addEventListener("mousemove", mouseMove, false);
  canvas.addEventListener("wheel", mouseWheel, false);

  /* SCENE RENDERING */
  function getExtents(positions) {
    const min = positions.slice(0, 3);
    const max = positions.slice(0, 3);
    for (let i = 3; i < positions.length; i += 3) {
      for (let j = 0; j < 3; ++j) {
        const v = positions[i + j];
        min[j] = Math.min(v, min[j]);
        max[j] = Math.max(v, max[j]);
      }
    }
    return {min, max};
  }

  function getGeometriesExtents(geometries) {
    return geometries.reduce(({min, max}, {data}) => {
      const minMax = getExtents(data.position);
      return {
        min: min.map((min, ndx) => Math.min(minMax.min[ndx], min)),
        max: max.map((max, ndx) => Math.max(minMax.max[ndx], max)),
      };
    }, {
      min: Array(3).fill(Number.POSITIVE_INFINITY),
      max: Array(3).fill(Number.NEGATIVE_INFINITY),
    });
  }

  const extents = getGeometriesExtents(obj_1.geometries);
  const range = m4.subtractVectors(extents.max, extents.min);
  // amount to move the object so its center is at the origin
  const objOffset = m4.scaleVector(
      m4.addVectors(
        extents.min,
        m4.scaleVector(range, 0.5)),
      -1);
  const cameraTarget = [0, 0, 0];
  // figure out how far away to move the camera so we can likely
  // see the object.
  const radius = m4.length(range) * 2.0;
  const cameraPosition = m4.addVectors(cameraTarget, [
    15,
    10,
    radius,
  ]);
  // Set zNear and zFar to something hopefully appropriate
  // for the size of this object.
  const zNear = radius / 100;
  const zFar = radius * 3;

  function degToRad(deg) {
    return deg * Math.PI / 180;
  }

  function turnAround(direction) {
    if (parseFloat(direction) > 0)
    {
      return 1;
    }
    else 
    {
      return -1;
    }
  }

  function render(time) {
    time *= 0.001;  // convert to seconds

    // For mouse events
    if (!drag) {
      dX *= AMORTIZATION, dY *= AMORTIZATION;
      THETA += dX, PHI += dY;
    }

    webglUtils.resizeCanvasToDisplaySize(gl.canvas);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);

    gl.clearColor(0.0, 0.0, 0.0, 1.0);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);  

    /* Render the skybox */
    gl.useProgram(skyboxProgramInfo.program);
    gl.enableVertexAttribArray(positionLocation);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);

    // Tell the position attribute how to get data out of positionBuffer (ARRAY_BUFFER)
    var size = 2;          // 2 components per iteration
    var type = gl.FLOAT;   // the data is 32bit floats
    var normalize = false; // don't normalize the data
    var stride = 0;        // 0 = move forward size * sizeof(type) each iteration to get the next position
    var offset = 0;        // start at the beginning of the buffer
    gl.vertexAttribPointer(
        positionLocation, size, type, normalize, stride, offset);

    const fieldOfViewRadians = degToRad(60);
    const aspect = gl.canvas.clientWidth / gl.canvas.clientHeight;
    const projection = m4.perspective(fieldOfViewRadians, aspect, zNear, zFar);

    const up = [0, 1, 0];
    // Compute the camera's matrix using look at.
    const camera = m4.lookAt(cameraPosition, cameraTarget, up);
    
    const skyboxCameraPosition = m4.addVectors(cameraTarget, [
      Math.cos(time * .075),
      0,
      Math.sin(time * .075),
    ]);
    const skyboxCamera = m4.lookAt(skyboxCameraPosition, cameraTarget, up);

    // Make a view matrix from the camera matrix.
    const view = m4.inverse(camera);
    const skyboxView = m4.inverse(skyboxCamera);

    // We only care about direction so remove the translation
    skyboxView[12] = 0;
    skyboxView[13] = 0;
    skyboxView[14] = 0;

    var skyboxViewDirectionProjection =
        m4.multiply(projection, skyboxView);
    var skyboxViewDirectionProjectionInverse =
        m4.inverse(skyboxViewDirectionProjection);

    gl.uniformMatrix4fv(
      skyboxViewDirectionProjectionInverseLocation, false,
      skyboxViewDirectionProjectionInverse);

    gl.uniform1i(skyboxLocation, 0);
    gl.depthFunc(gl.LEQUAL);
    gl.drawArrays(gl.TRIANGLES, 0, 1 * 6);

    const sharedUniforms = {
      u_lightDirection: m4.normalize([-1, 3, 5]),
      u_view: view,
      u_projection: projection,
    };
    
    var selectedProgramInfo;

    if (cloakMode === false) {
      selectedProgramInfo = meshProgramInfo;
    }
    else 
    {
      selectedProgramInfo = meshCloakProgramInfo;
    }

    gl.useProgram(selectedProgramInfo.program);

    var u_texture0Location = gl.getUniformLocation(selectedProgramInfo.program, "u_texture0");
    var u_texture1Location = gl.getUniformLocation(selectedProgramInfo.program, "u_texture1");
    var u_texture2Location = gl.getUniformLocation(selectedProgramInfo.program, "u_texture2");
    var u_skyboxLocation = gl.getUniformLocation(selectedProgramInfo.program, "u_skybox");

    var u_time = gl.getUniformLocation(selectedProgramInfo.program, "u_time");

    // calls gl.uniform
    webglUtils.setUniforms(selectedProgramInfo, sharedUniforms);

    gl.uniform1f(u_time, time);

    // compute the world matrix once since all parts
    // are at the same space.
    let u_world = m4.xRotation(PHI);
    u_world = m4.yRotate(u_world, THETA);
    u_world = m4.translate(u_world, ...objOffset);

    var fleetTime = time * 0.1; // fleet time - a.k.a "their speed"

    /* Render the first Battlecruiser */
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture_0);
    gl.uniform1i(u_texture0Location, 0);
    if (cloakMode === false) 
    {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, texture_1);
      gl.uniform1i(u_texture1Location, 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, texture_2);
      gl.uniform1i(u_texture2Location, 2);
    }
    else
    {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture_0);
      gl.uniform1i(u_skyboxLocation, 0);
    }

    for (var ii = 0; ii < num_object_1s; ++ii) {
      for (const {bufferInfo, material} of object_1_parts[ii]) {

      // calls gl.bindBuffer, gl.enableVertexAttribArray, gl.vertexAttribPointer
      webglUtils.setBuffersAndAttributes(gl, selectedProgramInfo, bufferInfo);
      // calls gl.uniform
      webglUtils.setUniforms(selectedProgramInfo, {
        // Translate each object separatedly
        u_world: m4.multiply(m4.yRotate(u_world, degToRad(90*turnAround(Math.cos(fleetTime)))), m4.translation(object_1_coords[ii][0], object_1_coords[ii][1], object_1_coords[ii][2] + turnAround(Math.cos(fleetTime)) * 40 * Math.sin(fleetTime))),
        u_diffuse: material.u_diffuse,
      });
      // calls gl.drawArrays or gl.drawElements
      webglUtils.drawBufferInfo(gl, bufferInfo);
      }
    }

    /* Render the second Battlecruiser */
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture_3);
    gl.uniform1i(u_texture0Location, 0);
    if (cloakMode === false) 
    {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, texture_4);
      gl.uniform1i(u_texture1Location, 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, texture_5);
      gl.uniform1i(u_texture2Location, 2);
    }
    else
    {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture_3);
      gl.uniform1i(u_skyboxLocation, 0);
    }
    
    for (var ii = 0; ii < num_object_2s; ++ii) {
      for (const {bufferInfo, material} of object_2_parts[ii]) {

      // calls gl.bindBuffer, gl.enableVertexAttribArray, gl.vertexAttribPointer
      webglUtils.setBuffersAndAttributes(gl, selectedProgramInfo, bufferInfo);
      // calls gl.uniform
      webglUtils.setUniforms(selectedProgramInfo, {
        // Translate each object separatedly
        u_world: m4.multiply(m4.yRotate(u_world, degToRad(90*turnAround(Math.cos(fleetTime)))), m4.translation(object_2_coords[ii][0], object_2_coords[ii][1], object_2_coords[ii][2] + turnAround(Math.cos(fleetTime)) * 40 * Math.sin(fleetTime))),
        u_diffuse: material.u_diffuse,
      });
      // calls gl.drawArrays or gl.drawElements
      webglUtils.drawBufferInfo(gl, bufferInfo);
      }
    }

    /* Render the Wraith */
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture_6);
    gl.uniform1i(u_texture0Location, 0);
    if (cloakMode === false) 
    {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, texture_7);
      gl.uniform1i(u_texture1Location, 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, texture_8);
      gl.uniform1i(u_texture2Location, 2);
    }
    else
    {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture_6);
      gl.uniform1i(u_skyboxLocation, 0);
    }
    
    for (var ii = 0; ii < num_object_3s; ++ii) {
      for (const {bufferInfo, material} of object_3_parts[ii]) {

      // calls gl.bindBuffer, gl.enableVertexAttribArray, gl.vertexAttribPointer
      webglUtils.setBuffersAndAttributes(gl, selectedProgramInfo, bufferInfo);
      // calls gl.uniform
      webglUtils.setUniforms(selectedProgramInfo, {
        // Translate each object separatedly
        u_world: m4.multiply(m4.yRotate(u_world, degToRad(90*turnAround(Math.cos(fleetTime)))), m4.translation(object_3_coords[ii][0], object_3_coords[ii][1], object_3_coords[ii][2] + turnAround(Math.cos(fleetTime)) * 40 * Math.sin(fleetTime))),
        u_diffuse: material.u_diffuse,
      });
      // calls gl.drawArrays or gl.drawElements
      webglUtils.drawBufferInfo(gl, bufferInfo);
      }
    }

    /* Render the Viking */
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture_9);
    gl.uniform1i(u_texture0Location, 0);
    if (cloakMode === false) 
    {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, texture_10);
      gl.uniform1i(u_texture1Location, 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, texture_11);
      gl.uniform1i(u_texture2Location, 2);
    }
    else
    {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture_9);
      gl.uniform1i(u_skyboxLocation, 0);
    }
    
    for (var ii = 0; ii < num_object_4s; ++ii) {
      for (const {bufferInfo, material} of object_4_parts[ii]) {

      // calls gl.bindBuffer, gl.enableVertexAttribArray, gl.vertexAttribPointer
      webglUtils.setBuffersAndAttributes(gl, selectedProgramInfo, bufferInfo);
      // calls gl.uniform
      webglUtils.setUniforms(selectedProgramInfo, {
        // Translate each object separatedly
        u_world: m4.multiply(m4.yRotate(u_world, degToRad(90*turnAround(Math.cos(fleetTime)))), m4.translation(object_4_coords[ii][0], object_4_coords[ii][1], object_4_coords[ii][2] + turnAround(Math.cos(fleetTime)) * 40 * Math.sin(fleetTime))),
        u_diffuse: material.u_diffuse,
      });
      // calls gl.drawArrays or gl.drawElements
      webglUtils.drawBufferInfo(gl, bufferInfo);
      }
    }

    /* Render the Liberator */
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture_12);
    gl.uniform1i(u_texture0Location, 0);
    if (cloakMode === false) 
    {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, texture_13);
      gl.uniform1i(u_texture1Location, 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, texture_14);
      gl.uniform1i(u_texture2Location, 2);
    }
    else
    {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture_12);
      gl.uniform1i(u_skyboxLocation, 0);
    }
    
    for (var ii = 0; ii < num_object_5s; ++ii) {
      for (const {bufferInfo, material} of object_5_parts[ii]) {

      // calls gl.bindBuffer, gl.enableVertexAttribArray, gl.vertexAttribPointer
      webglUtils.setBuffersAndAttributes(gl, selectedProgramInfo, bufferInfo);
      // calls gl.uniform
      webglUtils.setUniforms(selectedProgramInfo, {
        // Translate each object separatedly
        u_world: m4.multiply(m4.yRotate(u_world, degToRad(90*turnAround(Math.cos(fleetTime)))), m4.translation(object_5_coords[ii][0], object_5_coords[ii][1], object_5_coords[ii][2] + turnAround(Math.cos(fleetTime)) * 40 * Math.sin(fleetTime))),
        u_diffuse: material.u_diffuse,
      });
      // calls gl.drawArrays or gl.drawElements
      webglUtils.drawBufferInfo(gl, bufferInfo);
      }
    }     

    /* Render the Raven */
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture_15);
    gl.uniform1i(u_texture0Location, 0);
    if (cloakMode === false) 
    {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, texture_16);
      gl.uniform1i(u_texture1Location, 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, texture_17);
      gl.uniform1i(u_texture2Location, 2);
    }
    else
    {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture_15);
      gl.uniform1i(u_skyboxLocation, 0);
    }
    
    for (var ii = 0; ii < num_object_6s; ++ii) {
      for (const {bufferInfo, material} of object_6_parts[ii]) {

      // calls gl.bindBuffer, gl.enableVertexAttribArray, gl.vertexAttribPointer
      webglUtils.setBuffersAndAttributes(gl, selectedProgramInfo, bufferInfo);
      // calls gl.uniform
      webglUtils.setUniforms(selectedProgramInfo, {
        // Translate each object separatedly
        u_world: m4.multiply(m4.yRotate(u_world, degToRad(90*turnAround(Math.cos(fleetTime)))), m4.translation(object_6_coords[ii][0], object_6_coords[ii][1], object_6_coords[ii][2] + turnAround(Math.cos(fleetTime)) * 40 * Math.sin(fleetTime))),
        u_diffuse: material.u_diffuse,
      });
      // calls gl.drawArrays or gl.drawElements
      webglUtils.drawBufferInfo(gl, bufferInfo);
      }
    }
    requestAnimationFrame(render);

  }
  requestAnimationFrame(render);
}

main();
