<?php
require_once __DIR__ . '/vendor/autoload.php';
use NFePHP\NFe\Make;
use NFePHP\NFe\Tools;
use NFePHP\Common\Certificate;

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(200); exit; }
if ($_SERVER['REQUEST_METHOD'] !== 'POST') { http_response_code(405); echo json_encode(['erro' => 'Metodo nao permitido']); exit; }

$body = json_decode(file_get_contents('php://input'), true);
if (!$body) { http_response_code(400); echo json_encode(['erro' => 'JSON invalido']); exit; }

// Campos obrigatórios
$empresa       = $body['empresa']       ?? 'matriz'; // sempre matriz para importação
$itens         = $body['itens']         ?? [];
$duimpNumero   = $body['duimpNumero']   ?? '';
$dataEmissao   = $body['dataEmissao']   ?? date('Y-m-d');
$dataEntrada   = $body['dataEntrada']   ?? date('Y-m-d');
$exportadorNome= $body['exportadorNome']?? 'EXPORTADOR EXTERIOR';
$exportadorEnd = $body['exportadorEnd'] ?? 'EXTERIOR SN';
$exportadorPais= $body['exportadorPais']?? 'China, República Popular';
$codPaisExp    = $body['codPaisExp']    ?? '1058';
$vFrete        = (float)($body['vFrete']    ?? 0);
$vSeguro       = (float)($body['vSeguro']   ?? 0);
$vSiscomex     = (float)($body['vSiscomex'] ?? 0);
$icmsAliquota  = (float)($body['icmsAliquota'] ?? 17.5);
$nNF           = $body['nNF']           ?? null;
$infCompl      = $body['infCompl']      ?? '';

if (!count($itens)) {
    http_response_code(400);
    echo json_encode(['erro' => 'Itens obrigatorios']);
    exit;
}

// Sempre Matriz RS para importação
$cnpjEmit  = '40981026000182';
$cUF       = 43;
$cMunEmit  = 4314902;
$xMunEmit  = 'Porto Alegre';
$ufEmit    = 'RS';
$ieEmit    = '0963852906';
$cepEmit   = '90820000';
$lgrEmit   = 'Rua Doutor Campos Velho';
$nroEmit   = '700';
$bairroEmit= 'Cristal';

$pfxPath   = '/opt/digoo-capturador/matriz_new.pfx';
$pfxPass   = 'Digoo7560';

$configJson = json_encode([
    'atualizacao' => date('Y-m-d H:i:s'),
    'tpAmb'       => 1,
    'razaosocial' => 'DIGOO BRASIL IMPORTACAO E DISTRIBUICAO LTDA',
    'siglaUF'     => $ufEmit,
    'cnpj'        => $cnpjEmit,
    'schemes'     => 'PL_009_V4',
    'versao'      => '4.00',
    'tokenIBPT'   => '',
    'CSC'         => '',
    'CSCid'       => '',
]);

// Calcular totais
$vProdTotal   = 0;
$vIITotal     = 0;
$vIPITotal    = 0;
$vPISTotal    = 0;
$vCOFINSTotal = 0;
$vICMSTotal   = 0;
$vBCICMSTotal = 0;

foreach ($itens as $it) {
    $vProdTotal   += (float)($it['vProd']    ?? 0);
    $vIITotal     += (float)($it['vII']      ?? 0);
    $vIPITotal    += (float)($it['vIPI']     ?? 0);
    $vPISTotal    += (float)($it['vPIS']     ?? 0);
    $vCOFINSTotal += (float)($it['vCOFINS']  ?? 0);
    $vBCICMSTotal += (float)($it['vBCICMS']  ?? 0);
    $vICMSTotal   += (float)($it['vICMS']    ?? 0);
}

$vNF = $vProdTotal + $vIITotal + $vIPITotal + $vPISTotal + $vCOFINSTotal + $vICMSTotal + $vFrete + $vSeguro + $vSiscomex;

try {
    $certificate = Certificate::readPfx(file_get_contents($pfxPath), $pfxPass);
    $tools = new Tools($configJson, $certificate);
    $tools->model('55');
    $make = new Make();

    // infNFe
    $std = new stdClass(); $std->versao = '4.00';
    $make->taginfNFe($std);

    // ide — tpNF=0 (entrada), idDest=1 (operação interna não, mas importação usa 1), finNFe=1 (normal)
    $std = new stdClass();
    $std->cUF    = $cUF;
    $std->cNF    = str_pad(rand(10000000,99999999), 8, '0', STR_PAD_LEFT);
    $std->natOp  = 'IMPORTACAO';
    $std->mod    = 55;
    $std->serie  = 1;
    $std->nNF    = (int)($nNF ?? 1);
    $std->dhEmi  = date('Y-m-d\TH:i:sP', strtotime($dataEmissao));
    $std->dhSaiEnt = date('Y-m-d\TH:i:sP', strtotime($dataEntrada));
    $std->tpNF   = 0; // 0 = entrada
    $std->idDest = 1; // 1 = operação interna (importação é sempre no estado do emitente)
    $std->cMunFG = $cMunEmit;
    $std->tpImp  = 1;
    $std->tpEmis = 1;
    $std->cDV    = 0;
    $std->tpAmb  = 1;
    $std->finNFe = 1; // 1 = NF-e normal
    $std->indFinal = 0;
    $std->indPres  = 0;
    $std->procEmi  = 0;
    $std->verProc  = 'DigooOPS 1.0';
    $make->tagide($std);

    // emit
    $std = new stdClass();
    $std->CNPJ  = $cnpjEmit;
    $std->xNome = 'DIGOO BRASIL IMPORTACAO E DISTRIBUICAO LTDA';
    $std->xFant = 'DIGOO GAMING';
    $std->IE    = $ieEmit;
    $std->IEST  = null;
    $std->CRT   = 3; // regime normal (Lucro Real)
    $make->tagemit($std);

    $std = new stdClass();
    $std->xLgr   = $lgrEmit;
    $std->nro    = $nroEmit;
    $std->xCpl   = null;
    $std->xBairro= $bairroEmit;
    $std->cMun   = $cMunEmit;
    $std->xMun   = $xMunEmit;
    $std->UF     = $ufEmit;
    $std->CEP    = $cepEmit;
    $std->cPais  = 1058;
    $std->xPais  = 'Brasil';
    $std->fone   = '51981482213';
    $make->tagenderEmit($std);

    // dest — na NF-e de entrada de importação, o destinatário é o próprio importador
    $std = new stdClass();
    $std->CNPJ       = $cnpjEmit;
    $std->xNome      = 'DIGOO BRASIL IMPORTACAO E DISTRIBUICAO LTDA';
    $std->indIEDest  = 1; // contribuinte ICMS
    $std->IE         = $ieEmit;
    $std->email      = null;
    $make->tagdest($std);

    $std = new stdClass();
    $std->xLgr   = $lgrEmit;
    $std->nro    = $nroEmit;
    $std->xBairro= $bairroEmit;
    $std->cMun   = $cMunEmit;
    $std->xMun   = $xMunEmit;
    $std->UF     = $ufEmit;
    $std->CEP    = $cepEmit;
    $std->cPais  = 1058;
    $std->xPais  = 'Brasil';
    $make->tagenderDest($std);

    // autXML
    $std = new stdClass(); $std->item = 1; $std->CNPJ = '40981026000182';
    $make->tagautXML($std);

    // Itens
    foreach ($itens as $idx => $it) {
        $item    = $idx + 1;
        $ncm     = preg_replace('/[^0-9]/', '', $it['ncm'] ?? '84145990');
        $cfop    = $it['cfop']    ?? '3102';
        $xProd   = $it['xProd']   ?? $it['descricao'] ?? 'Mercadoria importada';
        $cProd   = $it['sku']     ?? str_pad($item, 6, '0', STR_PAD_LEFT);
        $qCom    = number_format((float)($it['qCom']   ?? 1), 4, '.', '');
        $vUnCom  = number_format((float)($it['vUnCom'] ?? 0), 10, '.', '');
        $vProd   = number_format((float)($it['vProd']  ?? 0), 2, '.', '');
        $orig    = (int)($it['orig'] ?? 8); // 8 = importação direta

        // prod
        $std = new stdClass();
        $std->item     = $item;
        $std->cProd    = $cProd;
        $std->cEAN     = 'SEM GTIN';
        $std->xProd    = mb_strtoupper(mb_substr($xProd, 0, 120));
        $std->NCM      = $ncm;
        $std->CFOP     = $cfop;
        $std->uCom     = $it['uCom'] ?? 'UN';
        $std->qCom     = $qCom;
        $std->vUnCom   = $vUnCom;
        $std->vProd    = $vProd;
        $std->cEANTrib = 'SEM GTIN';
        $std->uTrib    = $it['uCom'] ?? 'UN';
        $std->qTrib    = $qCom;
        $std->vUnTrib  = $vUnCom;
        $std->indTot   = 1;
        $make->tagprod($std);

        // ICMS — CST 900 (CSOSN para Lucro Real = usar ICMS normal)
        // Para importação com Lucro Real, usar CST 00
        $vBCICMS  = number_format((float)($it['vBCICMS'] ?? 0), 2, '.', '');
        $pICMS    = number_format((float)($it['pICMS']   ?? $icmsAliquota), 4, '.', '');
        $vICMS    = number_format((float)($it['vICMS']   ?? 0), 2, '.', '');
        $std = new stdClass();
        $std->item  = $item;
        $std->orig  = $orig;
        $std->CST   = '00'; // tributado integralmente
        $std->modBC = 3;    // valor da operação
        $std->vBC   = $vBCICMS;
        $std->pICMS = $pICMS;
        $std->vICMS = $vICMS;
        $make->tagICMS($std);

        // II — Imposto de Importação
        $vII = (float)($it['vII'] ?? 0);
        if ($vII > 0) {
            $std = new stdClass();
            $std->item              = $item;
            $std->vBC               = number_format((float)($it['vBCII'] ?? $it['vmle'] ?? 0), 2, '.', '');
            $std->vDespAdu          = '0.00';
            $std->vII               = number_format($vII, 2, '.', '');
            $std->vIOF              = '0.00';
            $make->tagII($std);
        }

        // IPI
        $vIPI    = (float)($it['vIPI'] ?? 0);
        $pIPI    = (float)($it['pIPI'] ?? 0);
        $vBCIPI  = (float)($it['vBCIPI'] ?? $it['vmle'] ?? 0);
        $std = new stdClass();
        $std->item = $item;
        $std->cEnq = '999';
        if ($vIPI > 0) {
            $std->CST  = '50'; // saída tributada (entrada com IPI destacado)
            $std->vBC  = number_format($vBCIPI, 2, '.', '');
            $std->pIPI = number_format($pIPI, 4, '.', '');
            $std->vIPI = number_format($vIPI, 2, '.', '');
        } else {
            $std->CST  = '53'; // entrada isenta
            $std->vBC  = '0.00';
            $std->pIPI = '0.0000';
            $std->vIPI = '0.00';
        }
        $make->tagIPI($std);

        // PIS
        $vPIS   = (float)($it['vPIS']  ?? 0);
        $pPIS   = (float)($it['pPIS']  ?? 0);
        $vBCPIS = (float)($it['vBCPIS'] ?? $it['vmle'] ?? 0);
        $std = new stdClass();
        $std->item = $item;
        if ($vPIS > 0) {
            $std->CST  = '70'; // aquisição de longo prazo / importação
            $std->vBC  = number_format($vBCPIS, 2, '.', '');
            $std->pPIS = number_format($pPIS, 4, '.', '');
            $std->vPIS = number_format($vPIS, 2, '.', '');
        } else {
            $std->CST  = '70';
            $std->vBC  = '0.00';
            $std->pPIS = '0.0000';
            $std->vPIS = '0.00';
        }
        $make->tagPIS($std);

        // COFINS
        $vCOFINS   = (float)($it['vCOFINS']  ?? 0);
        $pCOFINS   = (float)($it['pCOFINS']  ?? 0);
        $vBCCOFINS = (float)($it['vBCCOFINS'] ?? $it['vmle'] ?? 0);
        $std = new stdClass();
        $std->item = $item;
        if ($vCOFINS > 0) {
            $std->CST     = '70';
            $std->vBC     = number_format($vBCCOFINS, 2, '.', '');
            $std->pCOFINS = number_format($pCOFINS, 4, '.', '');
            $std->vCOFINS = number_format($vCOFINS, 2, '.', '');
        } else {
            $std->CST     = '70';
            $std->vBC     = '0.00';
            $std->pCOFINS = '0.0000';
            $std->vCOFINS = '0.00';
        }
        $make->tagCOFINS($std);

        // DI — Declaração de Importação (DUIMP)
        $nDILimpo = preg_replace('/[^a-zA-Z0-9\-\/]/', '', $duimpNumero); // limpar caracteres inválidos
        $std = new stdClass();
        $std->item         = $item;
        $std->nDI          = $nDILimpo;
        $std->dDI          = date('Y-m-d', strtotime($dataEmissao));
        $std->xLocDesemb   = 'PORTO DE RIO GRANDE';
        $std->UFDesemb     = 'RS';
        $std->dDesemb      = date('Y-m-d', strtotime($dataEntrada));
        $std->tpViaTransp  = 1; // 1 = Marítima
        $std->vAFRMM       = '0.00';
        $std->tpIntermedio = 1; // 1 = importação por conta própria
        $std->CNPJ         = $cnpjEmit;
        $std->CPF          = null;
        $std->UFTerceiro   = null;
        $std->cExportador  = mb_substr(preg_replace('/[^a-zA-Z0-9 ]/', '', $exportadorNome), 0, 60);
        $make->tagDI($std);

        // adi (adição da DI) — nDI deve ser igual ao nDI da tagDI acima
        $std = new stdClass();
        $std->item        = $item;
        $std->nDI         = $nDILimpo; // DEVE ser igual ao nDI da tagDI
        $std->nAdicao     = $item;
        $std->nSeqAdic    = 1;
        $std->cFabricante = mb_substr(preg_replace('/[^a-zA-Z0-9 ]/', '', $exportadorNome), 0, 60);
        $std->vDescDI     = null; // omitir quando zero — NFePHP só aceita valores > 0
        $make->tagadi($std);
    }

    // Total
    $std = new stdClass();
    $std->vBC      = number_format($vBCICMSTotal, 2, '.', '');
    $std->vICMS    = number_format($vICMSTotal, 2, '.', '');
    $std->vICMSDeson = '0.00';
    $std->vFCP     = '0.00';
    $std->vBCST    = '0.00';
    $std->vST      = '0.00';
    $std->vFCPST   = '0.00';
    $std->vFCPSTRet= '0.00';
    $std->vProd    = number_format($vProdTotal, 2, '.', '');
    $std->vFrete   = number_format($vFrete, 2, '.', '');
    $std->vSeg     = number_format($vSeguro, 2, '.', '');
    $std->vDesc    = '0.00';
    $std->vII      = number_format($vIITotal, 2, '.', '');
    $std->vIPI     = number_format($vIPITotal, 2, '.', '');
    $std->vIPIDevo = '0.00';
    $std->vPIS     = number_format($vPISTotal, 2, '.', '');
    $std->vCOFINS  = number_format($vCOFINSTotal, 2, '.', '');
    $std->vOutro   = number_format($vSiscomex, 2, '.', '');
    $std->vTotTrib = '0.00';
    $std->vNF      = number_format($vNF, 2, '.', '');
    $make->tagICMSTot($std);

    // transp
    $std = new stdClass(); $std->modFrete = 1; // 1 = frete por conta do destinatário/importador
    $make->tagtransp($std);
    $std = new stdClass();
    $std->item   = 1;
    $std->pesoL  = '0.000';
    $std->pesoB  = '0.000';
    $make->tagvol($std);

    // pag obrigatório
    $std = new stdClass(); $std->vTroco = null;
    $make->tagpag($std);
    $std = new stdClass(); $std->item = 1; $std->tPag = '90'; $std->vPag = '0.00';
    $make->tagdetPag($std);

    // infAdic
    $totalPIS    = number_format($vPISTotal, 2, ',', '.');
    $totalCOFINS = number_format($vCOFINSTotal, 2, ',', '.');
    $totalSis    = number_format($vSiscomex, 2, ',', '.');
    $infComplFinal = $infCompl ?: "Conforme DUIMP Nr. {$duimpNumero} registrada em {$dataEmissao}, desembaracada em {$dataEntrada}, em PORTO DE RIO GRANDE. Os valores de PIS e COFINS na NF-e de entrada foram: PIS R$ {$totalPIS} COFINS R$ {$totalCOFINS}, a taxa SISCOMEX foi de R$ {$totalSis}. Nao houve multas no curso do despacho aduaneiro.";
    $std = new stdClass();
    $std->infCpl = $infComplFinal;
    $make->taginfAdic($std);

    // Gerar e assinar XML
    $xml = $make->getXML();
    $xmlAssinado = $tools->signNFe($xml);

    // Extrair chave
    $domTemp = new DOMDocument();
    $domTemp->loadXML($xmlAssinado);
    $chaveNF = $domTemp->getElementsByTagName('infNFe')->item(0)?->getAttribute('Id') ?? '';
    $chaveNF = preg_replace('/^NFe/', '', $chaveNF);
    $chaveTemp = $chaveNF ?: md5($xmlAssinado);

    if (!is_dir('/opt/digoo-nfe/xml')) mkdir('/opt/digoo-nfe/xml', 0755, true);
    file_put_contents("/opt/digoo-nfe/xml/{$chaveTemp}-nfe.xml", $xmlAssinado);

    // Enviar para SEFAZ
    $idLote = str_pad(rand(1, 999999999), 15, '0', STR_PAD_LEFT);
    $resp = $tools->sefazEnviaLote([$xmlAssinado], $idLote, 1);

    $dom = new DOMDocument(); $dom->loadXML($resp);
    $cStatLote = $dom->getElementsByTagName('cStat')->item(0)->nodeValue ?? '';

    $infProt = $dom->getElementsByTagName('infProt')->item(0);
    if ($infProt) {
        $cStat2   = $infProt->getElementsByTagName('cStat')->item(0)->nodeValue ?? '';
        $xMotivo2 = $infProt->getElementsByTagName('xMotivo')->item(0)->nodeValue ?? '';
        $chNFe    = $infProt->getElementsByTagName('chNFe')->item(0)->nodeValue ?? '';
        $nProt    = $infProt->getElementsByTagName('nProt')->item(0)->nodeValue ?? '';
        if ($chNFe) {
            $xmlOrig = file_get_contents("/opt/digoo-nfe/xml/{$chaveTemp}-nfe.xml");
            if ($xmlOrig) {
                $protNode = $dom->getElementsByTagName('protNFe')->item(0);
                $protXml  = $protNode ? $dom->saveXML($protNode) : '';
                $nfeProc  = '<?xml version="1.0" encoding="UTF-8"?><nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">' . $xmlOrig . $protXml . '</nfeProc>';
                file_put_contents("/opt/digoo-nfe/xml/{$chNFe}-proc.xml", $nfeProc);
                @unlink("/opt/digoo-nfe/xml/{$chaveTemp}-nfe.xml");
            }
        }
        echo json_encode(['ok' => $cStat2 === '100', 'cStat' => $cStat2, 'xMotivo' => $xMotivo2, 'chave' => $chNFe, 'nProt' => $nProt]);
    } elseif ($cStatLote === '103') {
        sleep(3);
        $nRec  = $dom->getElementsByTagName('nRec')->item(0)->nodeValue ?? '';
        $respC = $tools->sefazConsultaRecibo($nRec);
        $dom2  = new DOMDocument(); $dom2->loadXML($respC);
        $cStat2   = $dom2->getElementsByTagName('cStat')->item(0)->nodeValue ?? '';
        $xMotivo2 = $dom2->getElementsByTagName('xMotivo')->item(0)->nodeValue ?? '';
        $chNFe    = $dom2->getElementsByTagName('chNFe')->item(0)->nodeValue ?? '';
        $nProt    = $dom2->getElementsByTagName('nProt')->item(0)->nodeValue ?? '';
        if ($chNFe) {
            $xmlOrig = file_get_contents("/opt/digoo-nfe/xml/{$chaveTemp}-nfe.xml");
            if ($xmlOrig) {
                $protNode = $dom->getElementsByTagName('protNFe')->item(0);
                $protXml  = $protNode ? $dom->saveXML($protNode) : '';
                $nfeProc  = '<?xml version="1.0" encoding="UTF-8"?><nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">' . $xmlOrig . $protXml . '</nfeProc>';
                file_put_contents("/opt/digoo-nfe/xml/{$chNFe}-proc.xml", $nfeProc);
                @unlink("/opt/digoo-nfe/xml/{$chaveTemp}-nfe.xml");
            }
        }
        echo json_encode(['ok' => $cStat2 === '100', 'cStat' => $cStat2, 'xMotivo' => $xMotivo2, 'chave' => $chNFe, 'nProt' => $nProt]);
    } else {
        $xMotivo = $dom->getElementsByTagName('xMotivo')->item(0)->nodeValue ?? '';
        echo json_encode(['ok' => false, 'cStat' => $cStatLote, 'xMotivo' => $xMotivo]);
    }

} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['erro' => $e->getMessage()]);
}
