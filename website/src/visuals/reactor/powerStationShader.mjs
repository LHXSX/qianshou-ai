/** Coherent energy pulses follow the rendered cyan conduits; lettering is separate HTML. */
export const powerStationFragment = `
  varying vec2 vUv;
  uniform sampler2D artwork;
  uniform float time;
  uniform float aspect;
  uniform vec2 pointer;
  void main() {
    vec2 uv = vUv;
    float imageAspect = 1.5;
    // Cover preserves the reactor proportions at every viewport.
    if(aspect < imageAspect) uv.x = (uv.x-.5)*aspect/imageAspect+.5;
    else uv.y = (uv.y-.5)*imageAspect/aspect+.5;
    float depth = exp(-dot((uv-vec2(.51,.51))*vec2(1.7,1.2),(uv-vec2(.51,.51))*vec2(1.7,1.2)));
    uv += pointer*.008*depth;
    vec3 color = texture2D(artwork, uv).rgb;
    float core = exp(-pow((uv.x-.509)/.038,2.)-pow((uv.y-.556)/.126,2.));
    float breathe = .55+.45*sin(time*1.35);
    float plasma = pow(.5+.5*sin(uv.y*105.-time*3.),5.);
    color += vec3(.025,.12,.19)*core*(breathe*.75+plasma*.35);
    // Existing illuminated channels carry an outward radial pulse, without shifting steelwork.
    float cyan = smoothstep(.035,.24,color.b-color.r)*smoothstep(.03,.28,color.g);
    vec2 origin = vec2(.512,.397);
    float distanceToCore = length((uv-origin)*vec2(1.,1.3));
    float wave = pow(.5+.5*sin(distanceToCore*62.-time*2.3),14.);
    float floorMask = (1.-smoothstep(.27,.78,uv.y))*smoothstep(.06,.18,uv.y);
    color += vec3(.018,.08,.14)*cyan*wave*floorMask;
    // The containment ring reflects a traveling light, tied to its elliptical geometry.
    vec2 ring = (uv-vec2(.54,.784))/vec2(.173,.075);
    float ringMask = exp(-pow((length(ring)-1.)*13.,2.));
    float glint = pow(max(0.,cos(atan(ring.y,ring.x)-time*.23)),24.);
    color += vec3(.05,.09,.12)*ringMask*glint;
    float edge = smoothstep(0.,.055,vUv.x)*smoothstep(0.,.055,1.-vUv.x)*smoothstep(0.,.07,vUv.y)*smoothstep(0.,.07,1.-vUv.y);
    gl_FragColor = vec4(color,edge);
    #include <colorspace_fragment>
  }
`;
