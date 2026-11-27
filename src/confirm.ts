// A native modal keeps focus inside the decision and returns it to the invoking control.
export function confirmAction(message:string):Promise<boolean>{
 if(document.querySelector('dialog[data-confirm]'))return Promise.resolve(false);
 return new Promise(resolve=>{
 const dlg=document.createElement('dialog');dlg.dataset.confirm='true';dlg.className='decision';dlg.setAttribute('aria-label','Confirm action');
 const title=document.createElement('h2');title.textContent='Confirm action';const p=document.createElement('p');p.textContent=message;
 const footer=document.createElement('footer');const cancel=document.createElement('button');cancel.textContent='Cancel';cancel.className='secondary';cancel.autofocus=true;
 const confirm=document.createElement('button');confirm.textContent='Confirm';confirm.className='primary';
 function finish(ok:boolean){dlg.close();dlg.remove();resolve(ok)}
 cancel.onclick=()=>finish(false);confirm.onclick=()=>finish(true);dlg.oncancel=e=>{e.preventDefault();finish(false)};
 footer.append(cancel,confirm);dlg.append(title,p,footer);document.body.append(dlg);dlg.showModal();
 });
}
