const money = n => new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(n);
let products=[], cart=JSON.parse(localStorage.getItem("nl-cart")||"[]");
const $=id=>document.getElementById(id);
async function loadProducts(){
  const r=await fetch("/api/products"); products=await r.json();
  const cats=[...new Set(products.map(p=>p.category))];
  $("categoryFilter").innerHTML='<option value="">All categories</option>'+cats.map(c=>`<option>${escapeHtml(c)}</option>`).join("");
  renderProducts();
}
function escapeHtml(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function renderProducts(){
  const cat=$("categoryFilter").value;
  const list=products.filter(p=>!cat||p.category===cat);
  $("products").innerHTML=list.map(p=>`<article class="product-card"><img src="${escapeHtml(p.image||"https://placehold.co/600x500?text=Product")}" alt="${escapeHtml(p.name)}" loading="lazy"><div class="product-info"><small>${escapeHtml(p.category)}</small><h3>${escapeHtml(p.name)}</h3><p>${escapeHtml(p.description)}</p><div class="product-foot"><strong>${money(p.price)}</strong><button class="add-button" onclick="addToCart(${p.id})">ADD TO BAG +</button></div></div></article>`).join("")||"<p>No products in this category yet.</p>";
}
function saveCart(){localStorage.setItem("nl-cart",JSON.stringify(cart));renderCart();}
function addToCart(id){const p=products.find(x=>x.id===id);if(!p)return;const item=cart.find(x=>x.id===id);if(item)item.quantity=Math.min(10,item.quantity+1);else cart.push({id,quantity:1});saveCart();openCart();}
function removeFromCart(id){cart=cart.filter(x=>x.id!==id);saveCart();}
function renderCart(){
  $("cartCount").textContent=cart.reduce((n,x)=>n+x.quantity,0);
  let total=0;
  $("cartItems").innerHTML=cart.map(x=>{const p=products.find(y=>y.id===x.id);if(!p)return"";total+=p.price*x.quantity;return `<div class="cart-row"><div><strong>${escapeHtml(p.name)}</strong><p>${money(p.price)} × ${x.quantity}</p><button onclick="removeFromCart(${p.id})">Remove</button></div><strong>${money(p.price*x.quantity)}</strong></div>`}).join("")||'<p class="fine">Your bag is empty.</p>';
  $("cartTotal").textContent=money(total);
}
function openCart(){$("cartPanel").classList.add("open");$("overlay").classList.add("show");}
function closeCart(){$("cartPanel").classList.remove("open");$("overlay").classList.remove("show");}
$("cartToggle").onclick=openCart;$("closeCart").onclick=closeCart;$("overlay").onclick=closeCart;
$("categoryFilter").onchange=renderProducts;
$("checkoutButton").onclick=()=>{if(!cart.length)return;closeCart();$("checkout").classList.remove("hidden");$("checkout").scrollIntoView({behavior:"smooth"});};
$("backToShop").onclick=()=>$("checkout").classList.add("hidden");
$("checkoutForm").onsubmit=async e=>{
  e.preventDefault();$("checkoutError").textContent="";
  const f=new FormData(e.target), customer=Object.fromEntries(f.entries());
  const button=e.target.querySelector("button[type=submit]");button.disabled=true;button.textContent="Connecting to payment…";
  try{const r=await fetch("/api/checkout",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({customer,items:cart})});const data=await r.json();if(!r.ok)throw new Error(data.error||"Checkout failed");location.href=data.url;}
  catch(err){$("checkoutError").textContent=err.message;button.disabled=false;button.textContent="Continue to secure payment";}
};
loadProducts().then(renderCart);
