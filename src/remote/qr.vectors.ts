// Reference QR codes made by another encoder (segno 1.6.1, byte mode, no error correction boost),
// to check qr.ts against. Only codes that fill their version (segno adds a stray zero
// byte before the pad bytes, which the standard does not). Each matrix is its rows as one hex string (row by row, dark = 1).
// Generated, not edited by hand.

export interface QrVector {
  version: number;
  level: "L" | "M";
  mask: number;
  text: string;
  matrix: string;
  /** The reference's penalty score for this exact matrix (all four rules). */
  score: number;
  /** The mask was forced when this was made (so the penalty rules did not choose it). */
  forced?: boolean;
}

export const QR_VECTORS: readonly QrVector[] = [
  {
    "version": 1,
    "level": "L",
    "mask": 3,
    "text": ".5<CJQX_fmt!(/6=D",
    "matrix": "feb3fc12906ebabb75b5dbacaec11107faafe00100f2bcef2d33e6ad43b9813a683d806f93f99e50438eba104dd75c2eab1105ed1feb200",
    "score": 1066
  },
  {
    "version": 2,
    "level": "L",
    "mask": 2,
    "text": ";BIPW^elsz'.5<CJQX_fmt!(/6=DKRY`",
    "matrix": "fe67bfc140d06e964bb75f75dba27aec167907faaafe00c400fbae5530e0eb6ad1e67e18000c2d738ce0eca6adad977367b287c6f8004d44bfa8aab04e311baddf8dd4c152eba05b05d5a1fe9d178",
    "score": 1217
  },
  {
    "version": 3,
    "level": "L",
    "mask": 5,
    "text": "HOV]dkry&-4;BIPW^elsz'.5<CJQX_fmt!(/6=DKRY`gnu\")07>EL",
    "matrix": "fe0cabfc1336506e942ebb750fd5dbade12ec1150107faaaafe0054200c76278c50bde9ec1d8e3504b10649f76dd24d84e9c6a8bb59a14ab00feab6b912d6adfe53cc4cda32241528bb820ff806a8457fba4ea9052731aba49df8dd18e61ee806e3505a67c5fece93a0",
    "score": 1300
  },
  {
    "version": 4,
    "level": "L",
    "mask": 1,
    "text": "U\\cjqx%,3:AHOV]dkry&-4;BIPW^elsz'.5<CJQX_fmt!(/6=DKRY`gnu\")07>ELSZahov#*18?FMT",
    "matrix": "fef4c13fc17457506e99fd8bb747aad5dbaace72ec15301107faaaaafe01467400e6c3b979d8dbae58c4d45d4ab9a013039bef520a91a28e5597c9f66f5b336746e35a2ca1adc8cad77a4abd44d8aeae302707b1db23c0c99f4bbb69ef677a08b46592f775cbf8806fc6c4bf8cd42a305b02111ba085bf85d3c65812eb7ef133050655a8fe8943de8",
    "score": 1424
  },
  {
    "version": 5,
    "level": "L",
    "mask": 3,
    "text": "bipw$+29@GNU\\cjqx%,3:AHOV]dkry&-4;BIPW^elsz'.5<CJQX_fmt!(/6=DKRY`gnu\")07>ELSZahov#*18?FMT[bipw$+29@GNU\\cjq",
    "matrix": "fe91b223fc12e40c506ead4690bb7555dc85dbaaf17d2ec1134a0507faaaaaafe0070e4300f2bf456ceb0810e00315ee31fafd2959169042ea3e2aabcc8ebafd4d5f03c124152640c49a6f850e8d61416f4bb0ece97386470896936da8642aefca66f216d5a9e8c9a5100f28e43cbef68f89b6c1e0cc22eeded30ea8b531d16a34027ed7d5f9005b9fac67f9bd8aebf0400c431bba09b7afedd5c67af42eae21e57105a936becfefd586598",
    "score": 1658
  },
  {
    "version": 6,
    "level": "L",
    "mask": 2,
    "text": "ov#*18?FMT[bipw$+29@GNU\\cjqx%,3:AHOV]dkry&-4;BIPW^elsz'.5<CJQX_fmt!(/6=DKRY`gnu\")07>ELSZahov#*18?FMT[bipw$+29@GNU\\cjqx%,3:AHOV]dkry&-4",
    "matrix": "fe41cd453fc17bb348106e9e6904cbb752581905dba5399a4aec146e41d507faaaaaaafe00d52e6100fbf28ad8d56eba05a58c51d0ea1fabd78d70c62f38eaf5139020ce6efa05ff9a3502c9d552c259077bcacad2491876ad3717bd549ac83d86dc1816a0521e3266824c6887cd581be64d8631732022861d43d987f3415008c6cb1435bcf681630eb15a8452e43f2d23f7fb4c7dc0ff6b3bde99a40b51f92a607b140bab8a58b0fc00692a06c5ffab412cea50420593710baaee7acff5d6f049504aeb1fb860ef05943f53eafe9fc9a8140",
    "score": 1815
  },
  {
    "version": 7,
    "level": "L",
    "mask": 7,
    "text": "\")07>ELSZahov#*18?FMT[bipw$+29@GNU\\cjqx%,3:AHOV]dkry&-4;BIPW^elsz'.5<CJQX_fmt!(/6=DKRY`gnu\")07>ELSZahov#*18?FMT[bipw$+29@GNU\\cjqx%,3:AHOV]dkry&-4;BIPW^els",
    "matrix": "fe73b83a0bfc14b32150906eae0be964bb74a1246a35dba966fe2baec1773c43e107faaaaaaaafe019551ef400d3253f8a1bb34e68be840863ad8fe2c527b3f013fc7339a7f7c8ca9c98d4c3c0520cbc289bfbde0db91c09b579ae33e713d144ce1aa72c130d9c7a72fb3a0be46641fa2ffbc2fdc4fe8c548448445c6a7f6b8f2a7719c919a11b2fee7f9cbfa76daf868d6461f00021dc389160f897ce37732f077a2b8c099792822a38f9869e09a2adea4278623a642add58646a0b3048b3c2c35d79e9d6f13fa278aba9a277fdbefe00727c68dc57fadd6a2e2b9048e71f1b12ba03fff6bfedd6a3eda4f06e9f144d8361058f94ed800feb520b932b0",
    "score": 2119
  },
  {
    "version": 8,
    "level": "L",
    "mask": 7,
    "text": "/6=DKRY`gnu\")07>ELSZahov#*18?FMT[bipw$+29@GNU\\cjqx%,3:AHOV]dkry&-4;BIPW^elsz'.5<CJQX_fmt!(/6=DKRY`gnu\")07>ELSZahov#*18?FMT[bipw$+29@GNU\\cjqx%,3:AHOV]dkry&-4;BIPW^elsz'.5<CJQX_fmt!(/6=DKRY`gnu\"",
    "matrix": "fe288bbbb0bfc141e45b8fd06ea9eb3ac26bb74f20c40425dbabb6be7482ec163a91e3b107faaaaaaaaafe01c95445f700d3197bfe193b2683304eaa846ed9c0695e5e73b49396faa61a3a6ec9b9a6b101649c4d26595fee7ab4081b8929e019f7c833c6a3d4c98b5e8637144daf69e013392e856e14977f8ae955e8d23d96fe68ce3b12c8c224fe43efa7e7eb51a08c74b519eaa222b9b8a9b45f591c5ac7f3f24dffae3e23b89cf5ea042f7dbe5809cbcaa5e9e964f27e2bfd67b141fa52e4af695eed8731ae5b4cbc7a11232040d3e0a8959ee0cd6d39384103cc2bf2e72eecc886c69d20c782bd19dba5404aaee26356cf73dae3bb6bf2befe807b051ec546bfb57caedbaaf04b7ac6f5517ba746bee3af9dd79bb72625cae9ec0644a43d056e5b4d1988feeffe3dfd3d8",
    "score": 2291
  },
  {
    "version": 9,
    "level": "L",
    "mask": 6,
    "text": "<CJQX_fmt!(/6=DKRY`gnu\")07>ELSZahov#*18?FMT[bipw$+29@GNU\\cjqx%,3:AHOV]dkry&-4;BIPW^elsz'.5<CJQX_fmt!(/6=DKRY`gnu\")07>ELSZahov#*18?FMT[bipw$+29@GNU\\cjqx%,3:AHOV]dkry&-4;BIPW^elsz'.5<CJQX_fmt!(/6=DKRY`gnu\")07>ELSZahov#*18?FMT[bipw$+",
    "matrix": "fe8ccca6fe63fc11976785e1906e90e4b5e844bb744ccc191d55dba105efe4b22ec13d6fc6493107faaaaaaaaaafe01044d1a49100da397bfb0ffa092decc895917dcedb20d80b0111492455338e88b96732ac4ae91bea9ca73d039e6a4a1346342f3927b548366667ed42fe3819ee65ea467ca639cb39c6c2e9b26603b261067fdcaf5a54f24a26e7a8cf5600ce41591fe4497ee284d6371937d8d1b0440b6f86effcae8fcfc528547af1473abb2d2af8d2a37192e1180011e6fc27cffa82f94029e89dbe9ee52949dc5bbf892635da766018a57725b7467a9961688cc2bb3f7464b47657b6de48d88bebfd60fe96ad7fee8caf741e40850fad314d2fbe322bd0ca7609b1c70ccece66bb6db7a82943808cab13219fb7aa046b9dde86c27b87a17ac9513c5b6f83cdfa8053ee47b3f47bf959b6ae29aad047675129f111baee67f8caffddd422ff765f916e86facb8e78b905b03d377baf5fe8cf4c3cc4780",
    "score": 2564
  },
  {
    "version": 10,
    "level": "L",
    "mask": 3,
    "text": "IPW^elsz'.5<CJQX_fmt!(/6=DKRY`gnu\")07>ELSZahov#*18?FMT[bipw$+29@GNU\\cjqx%,3:AHOV]dkry&-4;BIPW^elsz'.5<CJQX_fmt!(/6=DKRY`gnu\")07>ELSZahov#*18?FMT[bipw$+29@GNU\\cjqx%,3:AHOV]dkry&-4;BIPW^elsz'.5<CJQX_fmt!(/6=DKRY`gnu\")07>ELSZahov#*18?FMT[bipw$+29@GNU\\cjqx%,3:AHOV]dkry&-4;BI",
    "matrix": "fef855dfc4af3fc109e553b7be906ea465f0c726cbb753a52eeb8625dbaa93b3fdf052ec10699d11d83107faaaaaaaaaaafe00edfec5738300f29c57fe74c34ef089b9f98036c823ba9cd39d19b66000fe301c2eb2817ddf9e3187527c4699420034eb21ceb91a8411ed5dd1b39d3a0c93bd2aa254d5d10ad7faebd1369c4304caacdd33aed26d5830c43c1f303491bbd1f9a54e2baeed0ab5748fce714f696c3d055f77e1c79309564c89465ae4705f32f38c4e8d3a27481a9fede4cfd30d3e431b5334797f91d6a9f042ba54fa9c473f9b1548fc553f83adfb9417e4e3dc9b4ffe2ca2e20e9fa4218626f0e908428214a0aace491c262a9de68d468d1d2ce306f06f0027d12fd10012d99a9c40b76adefdf19d607db23d674f3ba6fec78091bae03b9892a2e8b650abb6479f659dbe57650f926312455a71242cd9e0667d0e4b4d402db2a9c5969cf1f597df9587f2a2c63c755e8a0204a97f3854fc80761e91274a46ff94932ae8a66b10412dc474fe315ba4a9dfec219fb5d594223ba6140aeb0f6b019f9a0105ee67908918d1feaa4b0530a7140",
    "score": 2800
  },
  {
    "version": 1,
    "level": "M",
    "mask": 5,
    "text": ".5<CJQX_fmt!(/",
    "matrix": "fe7bfc17106ea2bb75b5dba6aec11507faafe0120082d6740f2fa9939810d857eb500052a7f8a89043fcba0b3dd1392e86a70499cfedfb0",
    "score": 1063
  },
  {
    "version": 2,
    "level": "M",
    "mask": 7,
    "text": ";BIPW^elsz'.5<CJQX_fmt!(/6",
    "matrix": "fe2c3fc12c906e802bb74ef5dba18aec164907faaafe00950096b7d0729ad38cce21732ec71671cb684eabba8eea8aa99f51d2c1fc005a44ff886b3051317ba0cff5d522d2e8bc2b04c9d0fe9e998",
    "score": 1083
  },
  {
    "version": 3,
    "level": "M",
    "mask": 5,
    "text": "HOV]dkry&-4;BIPW^elsz'.5<CJQX_fmt!(/6=DKRY",
    "matrix": "fe1cabfc15f6506ea42ebb751fd5dba3612ec1150107faaaafe011420082827e75c55e9ef4d6e3512a406495bedd249cee9c68ef359a0a1800fe6b53912ca2dfe53ab4cda323d1528af7a0ff80428457f9e4ea904e7319ba2fdf95d0ce616e9a6e3504e67c5fec493a0",
    "score": 1267
  },
  {
    "version": 4,
    "level": "M",
    "mask": 2,
    "text": "U\\cjqx%,3:AHOV]dkry&-4;BIPW^elsz'.5<CJQX_fmt!(/6=DKRY`gnu\")07>",
    "matrix": "fe48d63fc11fd6106eb6e3cbb750bb35dbabe2daec16981507faaaaafe01826800be0766be7a67491a4781c92096311798f0fd8c9411a5834a28ba37b9e4c98a2c360f8a939d24fed83963a0728d09a750d3de36150d0e8ec17a3aeb1d9a3d22dc5ae5ae058afd8061fe44ff99d0aa5054e6b1fbad540fc5d782506eea46a189045f1cccfea79bf30",
    "score": 1556
  },
  {
    "version": 5,
    "level": "M",
    "mask": 2,
    "text": "bipw$+29@GNU\\cjqx%,3:AHOV]dkry&-4;BIPW^elsz'.5<CJQX_fmt!(/6=DKRY`gnu\")07>ELSZahov#*1",
    "matrix": "fe0fcf23fc105b54d06ea6254abb75321ed5dbaa4762aec15bf33907faaaaaafe01e45e000be1349c3e04f094b39bffe79849e78225e25b77339ac6208b95a25a29d34a2f53914f19492e2e8d1b73c65c368080fa9cbafc603d419688672802d7a8cdb6805035f2e90dab829f7d308a31340a76529615a0921f0680d375b4c7d3118af313dfd805c6b344bf935336b7054d0b51aba88593fedd460b13eeebc52318f04d53b5b1fe998a46d8",
    "score": 1538
  },
  {
    "version": 6,
    "level": "M",
    "mask": 3,
    "text": "ov#*18?FMT[bipw$+29@GNU\\cjqx%,3:AHOV]dkry&-4;BIPW^elsz'.5<CJQX_fmt!(/6=DKRY`gnu\")07>ELSZahov#*18?FMT[bipw$",
    "matrix": "fe813840bfc162e1b6506e822232cbb75558dbb5dba5437982ec1149965d07faaaaaaafe0167a46e00b76169a225d0eb56f46f5185794ab50512976d1f34bcf4ec0179e2d8af98858a4ff91cf292fc4e02138755bb6308eca4946ee085875184b99728ad31976e2c9d98766b6c1d7d56cf2fe2053a6ca8dc55f2b85ac34e411786e6821d0b51f78caaf5b789f7f03b3e33e3a6348248f944cf0a8d4c01d3b00144f13b17467d5187fe804d1df7c77fb4b94aaa50541238518ba563a44ffdd79c00d0f6ea8353b70f040acc30a2fecd6a63d50",
    "score": 1672
  },
  {
    "version": 7,
    "level": "M",
    "mask": 3,
    "text": "\")07>ELSZahov#*18?FMT[bipw$+29@GNU\\cjqx%,3:AHOV]dkry&-4;BIPW^elsz'.5<CJQX_fmt!(/6=DKRY`gnu\")07>ELSZahov#*18?FMT[bipw$+29@G",
    "matrix": "fef3f11bcbfc14a442b4906e9c94dca4bb75c674c435dba3beff9faec1354c708107faaaaaaaafe0120b184700b75f4f9c025ee36972f4ef6eeb535ceaebf3244fb6cbbfe30b7a30627484d232cb1858af2cfc1c46af8a8d1cfcaa158366a02f06ea5c8faaebc98d234595c188f856e5bafdc8fff4fe3c78846b4c40aa182a41aa6313fd11b5128f912f831fc26fbaf7eaa90dd60424a02cd9a8574849dc782a5f397872e3612ed446d81d94aad30f86fb0da16337a1764c6efa0650f69c5242f5a88ad7def1bedacbd7b9b8a4fc06fb805ee4788c67fb67ead42a105baf156f16ba3d2fc18fa5d6c3dc4b426eb7d88e3f5d04aacbc2351fee3d47b4a40",
    "score": 1937
  },
  {
    "version": 8,
    "level": "M",
    "mask": 4,
    "text": "/6=DKRY`gnu\")07>ELSZahov#*18?FMT[bipw$+29@GNU\\cjqx%,3:AHOV]dkry&-4;BIPW^elsz'.5<CJQX_fmt!(/6=DKRY`gnu\")07>ELSZahov#*18?FMT[bipw$+29@GNU\\cjqx%,3:AHOV]dkr",
    "matrix": "fea144e780bfc12f5ecc37d06e9ae9c9a26bb75320c3aaa5dba833bf6d02ec15bdb1489107faaaaaaaaafe01220c4194008be567e2acfcc2cde77b69ba85db7ff9fdd45d945b6895b8d86f945e2ac8a2cad67fb49b1a4b7ae1f80815fb57142a944dc61895e4ca8f065a95fb69b23acd387bdf8551ac9d4267bedda2ea384ca8e980676f7a7b023f1e8fe9ebf4111e346ed11f3aaa42a4cbae746fd717a5470fedb9fadbff5d381c9c11c1ef6659484cadfe68cf5c7a5b414cd4915bd86c780d2a2ef23e1b6956c08e1e181f34c3a53704feb574f9a0c0bb1492230f7ffc7f4a08c799ae9d4c92f7591b3b463aca08e2f5a6eab405e3e2a7e08ef88058771b2f463fb055acf8ead04a19c665b1dbaae57e08effdd22956f2f9dee96fd0e9ea5f04c83b887b0efe98d5f6e96f8",
    "score": 2377
  },
  {
    "version": 9,
    "level": "M",
    "mask": 4,
    "text": "<CJQX_fmt!(/6=DKRY`gnu\")07>ELSZahov#*18?FMT[bipw$+29@GNU\\cjqx%,3:AHOV]dkry&-4;BIPW^elsz'.5<CJQX_fmt!(/6=DKRY`gnu\")07>ELSZahov#*18?FMT[bipw$+29@GNU\\cjqx%,3:AHOV]dkry&-4;BIPW^elsz'.5",
    "matrix": "fed86a9ecba3fc112012ad5d906e979ff2e3d4bb7508756489d5dbafb5afec2e2ec15d1644a77107faaaaaaaaaafe01388914343008ba52dfe8927cb445ce072b1e610df76c63d9eeaaa280c9892a53872535a0a80b9b86df8af8d36398a1618f41bdeb2a18488aa097afb3f3962da309ec1ef7a1c974f79a112e2b0a60319ea101f7b5d96f68c9d2fd02c8e1a8979ad34de8a6ba23b75532e9c8508159be80fd6c5f9df5fabc6d43c7a9d4776aa2a6b8e6abf112b0713f2918cfbd14fbed6fe4cafadcbe39afcc943d5459bab6a2ca739cd6e13324b842ecc7f92297dee303ffe05f5274462a893e9a155f2641a09ec814a4be5e53442681945f6daae470409482bbe8cd4ab10f16aaef451a6bb7b4645433bd21bbc77b67fdf84f0e2c09b0cd535fdb1313adff991fd007e20c7653c67fa06eaad116af0447c51f96f1abaa5e8fdbb3fb5d0d587769592ee919cb9ea18c504c8079bb88f3fedfc093893790",
    "score": 2601
  },
  {
    "version": 10,
    "level": "M",
    "mask": 3,
    "text": "IPW^elsz'.5<CJQX_fmt!(/6=DKRY`gnu\")07>ELSZahov#*18?FMT[bipw$+29@GNU\\cjqx%,3:AHOV]dkry&-4;BIPW^elsz'.5<CJQX_fmt!(/6=DKRY`gnu\")07>ELSZahov#*18?FMT[bipw$+29@GNU\\cjqx%,3:AHOV]dkry&-4;BIPW^elsz'.5<CJQX_fmt!(/6=DKRY`gnu",
    "matrix": "fe8752d7d8733fc1662f97da90906e9ba305ea58cbb75ac32e4b0225dba63e43ed2412ec1158ad1df7d107faaaaaaaaaaafe0131e7c4e24a00b74e177e51c4a58ccd19f1ce3a634ee57b4aaa86a1ed14b6f96eeec107bfdfc6559362050ed78006b421470a8b76f0a38bb1ea6927b19952be82df3366e50d659629e0ae3ae78ad9a7672158bdccd0b82e7547b8513efe5edbe2480faf87aae7926f64c38d6d290a8ebf66704aad1feaa1cb7302ae403c70d782b5b128e1aa3b17fd510fcd9dfe5511b074520d71eaa82612bb35bae0c683991b42dc7cfee20fffe7ebfc3a8ef4054b9cd88a884e8052e6679675b3da8e7c8294dabadb542d7b59a8d84df3079ca67cbb2d26824764233c21b6d427bcbf7555f71f7359e1a5995d63dbfda78dd9cde43d4be0650d3618852477f78395ac02d6922194214c151a23be748a51582dc284a62c000f0e2e9b9818572156eff073dbccb14e7b02ad32ff0e50fc00660411e7c8c4ffb79faa97292a105a1be47bb3317ba7863bea069fadd4479b6f44be8aeaf2de9c08261104b52b1a1161d1fe87c80263e58c0",
    "score": 2789
  },
  {
    "version": 3,
    "level": "M",
    "mask": 0,
    "text": "bipw$+29@GNU\\cjqx%,3:AHOV]dkry&-4;BIPW^els",
    "matrix": "fe7863fc176ed06e8aaabb74cce5dba8862ec13d9907faaaafe00ccc00aa2890918a5f0074ab1176f8b888a2e95078f0b213059c6228f436ff584fbc5e83438233e5840056e16bbcb875dcfc80470c6ff99bea704ddf1bbaeacfc5d3c38beeba197b04229a2fed95eb8",
    "score": 1423,
    "forced": true
  },
  {
    "version": 3,
    "level": "M",
    "mask": 1,
    "text": "bipw$+29@GNU\\cjqx%,3:AHOV]dkry&-4;BIPW^els",
    "matrix": "fead33fc11c4506ebffebb746645dba5d32ec1573107faaaafe0066600a37dc12b20f5aae1fe442252122207bc052dda18b9acc9377dbe9c55f21ae90bd1e9289970d155024bc1161d2089f9806da447faceab30477511ba3f9f95d169216eaf4c2f0488308fe8c0be8",
    "score": 1374,
    "forced": true
  },
  {
    "version": 3,
    "level": "M",
    "mask": 2,
    "text": "bipw$+29@GNU\\cjqx%,3:AHOV]dkry&-4;BIPW^els",
    "matrix": "fe1bebfc138d506eb248bb75f405dbaebeaec173a107faaaafe01f4200be4b1be7a2bc8e7a93f2f972806b2167689b123c2be57fec100c957160775fd0bd6b61bdebbce3d96b535f3bfbe4ff0049344ff815ea905e5113ba894ffdd72005eea2faf5041a79afebad080",
    "score": 1361,
    "forced": true
  },
  {
    "version": 3,
    "level": "M",
    "mask": 3,
    "text": "bipw$+29@GNU\\cjqx%,3:AHOV]dkry&-4;BIPW^els",
    "matrix": "fe9bebfc1556106e8924bb75f405dba3082ec1057907faaaafe0142f00b726aa5fa2bc8e57a52994c05b069167689b48519d3e1a5acb6c957160c384bd0ba00c0b2bbce3d802e584566d3ffa8049344ffb786a5053e718ba094ffdd5fb686eb99743041a79afee1bd30",
    "score": 1346,
    "forced": true
  },
  {
    "version": 3,
    "level": "M",
    "mask": 4,
    "text": "bipw$+29@GNU\\cjqx%,3:AHOV]dkry&-4;BIPW^els",
    "matrix": "fedcf3fc11b5906e9c70bb7585c5dbaacf2ec1502d07faaaafe0185e008b8c07cc2c846dd99dca1a6af1ac367b195c2adfa5df4f0f9e3d126d110698cccee5595e48b2db3a7322982ce795f8006abc77faf66ab0494d12bace5f8dd118e66e8cc217046bbebfefdccf0",
    "score": 1260,
    "forced": true
  },
  {
    "version": 3,
    "level": "M",
    "mask": 5,
    "text": "bipw$+29@GNU\\cjqx%,3:AHOV]dkry&-4;BIPW^els",
    "matrix": "fe2d33fc1585506eb248bb753315dba6beaec1132107faaaafe017620082cb1e7665a0ffba93f2f952026307bc052d9a1ca9ed7fec100b8900a7775fd0bde9699d70d155034bd1571bfbe4ff0078f453f815ea90467111ba3f9f95d128256e82faf504dd65dfebad080",
    "score": 1426,
    "forced": true
  },
  {
    "version": 3,
    "level": "M",
    "mask": 6,
    "text": "bipw$+29@GNU\\cjqx%,3:AHOV]dkry&-4;BIPW^els",
    "matrix": "fead33fc15b5906ebb6cbb743315dbaf9a2ec10b4107faaaafe007a1009fef8cbe65a0ffb3b760b14a63e517bc052daadfa5dc5b7e592b8900a753cd999d88ef8530d1550388dd67df69adfb8078f453fa5cea10506910babf9f95d518e66e8bde6704dd65dfea899a0",
    "score": 1433,
    "forced": true
  },
  {
    "version": 3,
    "level": "M",
    "mask": 7,
    "text": "bipw$+29@GNU\\cjqx%,3:AHOV]dkry&-4;BIPW^els",
    "matrix": "fe7863fc124a506e8e38bb74cce5dba2cf2ec174bd07faaaafe0085e0096badd018a5f0066e235e4b19c1ae2e95078d4205a210e2b0c7436ff580698ccca67107ae58400567322982a3cf8fe80470c6ff909ab505f971fba6acfc5d6e719ae9e8b3304229a2fefdccf0",
    "score": 1380,
    "forced": true
  }
];
