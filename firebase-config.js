// ============================================================
// ★ このファイルだけ自分用に書き換えてください(READMEの手順4)
// Firebaseコンソール → プロジェクトの設定 → マイアプリ →
// 「SDK の設定と構成」に表示される firebaseConfig をコピーして
// 下の値を置き換えます。
// ※ このconfigは公開しても問題ありません(データはFirestoreの
//    セキュリティルールで保護されます)
// ============================================================
export const firebaseConfig = {
 apiKey: "AIzaSyCaWY0-3hmkVP4y-91L36lbRHma2jczOqI",
  authDomain: "family-schedule-board.firebaseapp.com",
  projectId: "family-schedule-board",
  storageBucket: "family-schedule-board.firebasestorage.app",
  messagingSenderId: "46781366760",
  appId: "1:46781366760:web:5bdf93d3ba212342b2e45d"
};

// 家族アカウント用の固定メールアドレス。
// 実在しないアドレスでも動きますが、あとで合言葉を変更したく
// なったときのために「ご自身の実在アドレス」にしておくのが
// おすすめです(README「困ったとき」参照)。
export const FAMILY_EMAIL = "sugiharakazunari20@gmail.com";
