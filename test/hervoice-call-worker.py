import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('worker',Path(__file__).parent.parent/'hooks/hervoice-call-worker.py')
worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)

class JudgeTests(unittest.TestCase):
    def fake(self, response):
        class Module:
            TAGS=['平静','难过']
            seen=''
            def _tone(self, features): return '比平时偏轻'
            def _llm(self, prompt, max_tokens=0): self.seen=prompt;return response
        return Module()
    def test_no_forced_emotion(self):
        for response in ['{"status":"neutral","tags":[],"confidence":0.9}',
                         '{"status":"ready","tags":[],"confidence":0.9}']:
            result=worker.judge(self.fake(response),'没事',{'duration_s':2},None,[],[])
            self.assertEqual(result['tags'],[])
            self.assertNotEqual(result['status'],'ready')
    def test_uncertainty_does_not_become_a_fact(self):
        result=worker.judge(self.fake('{"status":"ready","tags":["难过"],"confidence":0.2}'),
                            '没事',{'duration_s':2},None,[],[])
        self.assertEqual(result['status'],'uncertain');self.assertEqual(result['tags'],[])
    def test_short_voice_bypasses_model(self):
        module=self.fake('not json')
        self.assertEqual(worker.judge(module,'嗯',{'duration_s':.3},None,[],[])['status'],'too_short')
        self.assertEqual(module.seen,'')
    def test_correction_and_context_are_available(self):
        module=self.fake('{"status":"ready","tags":["平静"],"confidence":0.8}')
        result=worker.judge(module,'嗯',{'duration_s':2},None,[{'text':'刚刚在开玩笑'}],[{'tags':['平静']}])
        self.assertEqual(result['tags'],['平静']);self.assertIn('刚刚在开玩笑',module.seen)
        self.assertIn('nor_corrections',module.seen)

if __name__=='__main__':unittest.main()
